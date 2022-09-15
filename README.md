@pokutuna/envelop-response-cache-firestore
===

Firestore cache implementation for [@envelop/response-cache](https://www.npmjs.com/package/@envelop/response-cache) plugin.

Provides response caching that works well with serverless environments.

Check out [the GraphQL Response Cache Guide](https://envelop.dev/docs/guides/adding-a-graphql-response-cache) and [Envelop](https://www.envelop.dev/) for more information


## Getting Started

```sh
yarn add @envelop/response-cache
yarn add @pokutuna/envelop-response-cache-firestore
```

```ts
import {envelop} from '@envelop/core';
import {useResponseCache} from '@envelop/response-cache';
import {createFirestoreCache} from '@pokutuna/envelop-response-cache-firestore';
import {Firestore} from '@google-cloud/firestore';

// ...

const firestore = new Firestore({projectId});
const cache = createFirestoreCache({firestore});

const getEnveloped = envelop({
  plugins: [
    // ... other plugins ...
    useResponseCache({cache}),
  ],
});
```

## Notice

TODO
- If you need performance, use Redis
- Not waiting for the write to complete in order to return a response faster


### Invalidate Cache

```ts
await cache.invalidate([
  // invalidate specific entities
  {typename: 'User', id: '1'},
  {typename: 'User', id: '2'},

  // invalidate all Comment entity
  {typename: 'Comment'},
]);
```

### Delete expired cache entry

Expired cache entries are not automatically deleted.
Recommend to run the following periodically.

```ts
await cache.deleteExpiredCacheEntry();
```

Or use TTL policies in Firestore (preview).

- Collection group: `responseCache` (default)
- Timestamp field: `expireAt`

See [Manage data retention with TTL policies](https://cloud.google.com/firestore/docs/ttl).
