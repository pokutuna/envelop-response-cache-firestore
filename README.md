@pokutuna/envelop-response-cache-firestore
===

[![npm version](https://badge.fury.io/js/@pokutuna%2Fenvelop-response-cache-firestore.svg)](https://badge.fury.io/js/@pokutuna%2Fenvelop-response-cache-firestore) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Firestore](https://cloud.google.com/firestore) cache implementation for [@envelop/response-cache](https://www.npmjs.com/package/@envelop/response-cache) plugin.

Provides response caching that works well with serverless environments on Google Cloud.

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

const firestore = new Firestore({projectId: 'YOUR_PROJECT_ID'});
const cache = createFirestoreCache({firestore});

const getEnveloped = envelop({
  plugins: [
    // ... other plugins ...
    useResponseCache({cache}),
  ],
});
```

Or, for use with GraphQL Yoga, see [this doc](https://www.the-guild.dev/graphql/yoga-server/v3/features/envelop-plugins).


### Options

```ts
const cache = createFirestoreCache({
  // Firestore instance to store cache entries (required)
  firestore: new Firestore(),

  // Firestore collection path to store cache entries (default: "responseCache")
  // You can use subcollection (e.g. "_internals_/cache/entries")
  collectionPath: 'responseCache',

  // Customize entity id string conversion for invalidation (usually not required to use)
  buildEntityId: (typename: string, id: number | string) => `${typename}#${id}`,
})
```


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


## Notice

- If you need performance, I recommend to use [the Redis version](https://www.npmjs.com/package/@envelop/response-cache-redis) officially provided.
  - The package is aimed at ease of setup with serverless environments and low cost.
- The envelop implementation does not wait for the write to complete in order to return a response faster.
- When a highly referenced cache expires, the same document will be updated in a short period and which may affect performance.
  - See the [Quotas and limits](https://cloud.google.com/firestore/quotas#soft_limits) documentation.
