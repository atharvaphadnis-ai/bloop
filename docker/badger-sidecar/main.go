// badger-sidecar/main.go — OPTIONAL isolated compatibility bridge that exposes
// BadgerDB (a Go library) over HTTP so the Node.js platform can use it as a
// key-value provider. This is the only Go code in the repository and it runs
// as a separate container — it is never part of the Node backend.
//
// Endpoints (all JSON):
//   GET  /health            → { "status": "ok", "entries": n }
//   POST /kv                → body: { "op": "get"|"put"|"delete"|"scan"|"count",
//                                     "key": "...", "value": "...",
//                                     "prefix": "...", "limit": 100 }
//   GET  /kv?key=...        → same as op=get
//
// Configure Bloop with provider "badger" and endpoint http://badger:8089.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	badger "github.com/dgraph-io/badger/v4"
)

var db *badger.DB

type kvRequest struct {
	Op     string `json:"op"`
	Key    string `json:"key"`
	Value  string `json:"value"`
	Prefix string `json:"prefix"`
	Limit  int    `json:"limit"`
}

type kvResponse struct {
	Found bool     `json:"found,omitempty"`
	Value string   `json:"value,omitempty"`
	Items []kvItem `json:"items,omitempty"`
	Count int64    `json:"count,omitempty"`
	Error string   `json:"error,omitempty"`
}

type kvItem struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apiKey := os.Getenv("BADGER_API_KEY")
		if apiKey != "" && r.Header.Get("Authorization") != "Bearer "+apiKey {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(kvResponse{Error: "unauthorized"})
			return
		}
		next(w, r)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	var count int64
	db.View(func(txn *badger.Txn) error {
		it := txn.NewIterator(badger.DefaultIteratorOptions)
		defer it.Close()
		for it.Rewind(); it.Valid(); it.Next() {
			count++
		}
		return nil
	})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "ok", "entries": count, "time": time.Now().UTC()})
}

func kvHandler(w http.ResponseWriter, r *http.Request) {
	var req kvRequest
	// accept both GET (?key=) and POST (JSON body)
	if r.Method == http.MethodGet {
		req.Op = "get"
		req.Key = r.URL.Query().Get("key")
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad JSON body: "+err.Error())
			return
		}
	}
	if req.Limit <= 0 {
		req.Limit = 100
	}
	resp := kvResponse{Items: []kvItem{}}

	err := db.View(func(txn *badger.Txn) error {
		switch req.Op {
		case "get":
			item, err := txn.Get([]byte(req.Key))
			if err == badger.ErrKeyNotFound {
				return nil
			}
			if err != nil {
				return err
			}
			val, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			resp.Found = true
			resp.Value = string(val)
			return nil
		case "scan":
			opts := badger.DefaultIteratorOptions
			opts.PrefetchValues = true
			it := txn.NewIterator(opts)
			defer it.Close()
			prefix := []byte(req.Prefix)
			for it.Seek(prefix); it.ValidForPrefix(prefix) && len(resp.Items) < req.Limit; it.Next() {
				item := it.Item()
				val, err := item.ValueCopy(nil)
				if err != nil {
					return err
				}
				resp.Items = append(resp.Items, kvItem{Key: string(item.KeyCopy(nil)), Value: string(val)})
			}
			return nil
		case "count":
			opts := badger.DefaultIteratorOptions
			opts.PrefetchValues = false
			it := txn.NewIterator(opts)
			defer it.Close()
			var n int64
			for it.Rewind(); it.Valid(); it.Next() {
				n++
			}
			resp.Count = n
			return nil
		}
		return fmt.Errorf("unsupported read op %q", req.Op)
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.Op == "put" || req.Op == "delete" {
		err = db.Update(func(txn *badger.Txn) error {
			switch req.Op {
			case "put":
				e := badger.NewEntry([]byte(req.Key), []byte(req.Value))
				return txn.SetEntry(e)
			case "delete":
				return txn.Delete([]byte(req.Key))
			}
			return fmt.Errorf("unsupported write op %q", req.Op)
		})
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		resp.Found = true
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(kvResponse{Error: msg})
}

func main() {
	dataDir := os.Getenv("BADGER_DATA_DIR")
	if dataDir == "" {
		dataDir = "/data/badger"
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("cannot create data dir: %v", err)
	}
	var err error
	db, err = badger.Open(badger.DefaultOptions(filepath.Join(dataDir, "badger")).
		WithLogger(nil))
	if err != nil {
		log.Fatalf("cannot open badger: %v", err)
	}
	defer db.Close()

	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
		again:
			err := db.RunValueLogGC(0.7)
			if err == nil {
				goto again
			}
		}
	}()

	port := os.Getenv("BADGER_PORT")
	if port == "" {
		port = "8089"
	}
	http.HandleFunc("/health", requireAuth(healthHandler))
	http.HandleFunc("/kv", requireAuth(kvHandler))
	log.Printf("badger-sidecar listening on :%s (data: %s)", port, dataDir)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
