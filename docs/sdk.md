# SDKs

Generate per-project clients from the dashboard (API Explorer → Generate) or `bloop sdk generate <pid>`. Output: `sdk/generated/<pid>/{bloop-js,bloop-ts,bloop-python,bloop-go,bloop-dart}/…` plus a README, or download the ZIP directly.

```js
import BloopClient from './bloop-js/index.js';
const bloop = new BloopClient();                    // baseUrl/project/anon key baked in
await bloop.login('user@example.com', 'password1');
const rows = await bloop.from('posts').select().eq('status', 'published').limit(10).all();
await bloop.upload('uploads', file);
bloop.realtime().onDatabaseChange('posts', console.log);
```

All five SDKs cover auth (register/login/refresh/me), DB queries with filters/order/pagination, NoSQL helpers, storage upload/download, function invocation, GraphQL and error normalization. Templates live in `backend/infrastructure/sdk-generator.js`.
