/**
 * The test cases are based on the redis version provided by envelop officially.
 * https://github.com/n1ru4l/envelop/tree/main/packages/plugins/response-cache-redis
 */
import {request} from 'http';
import {createTestkit} from '@envelop/testing';
import {makeExecutableSchema} from '@graphql-tools/schema';
import {
  BuildEntityId,
  CacheEntityRecord,
  useResponseCache,
} from '@envelop/response-cache';
import {
  CollectionReference,
  Firestore,
  QueryDocumentSnapshot,
} from '@google-cloud/firestore';
import {
  createFirestoreCache,
  defaultBuildEntityId,
  defaultCollectionPath,
} from '../src/index';

const projectId = 'test';

async function flushAll(): Promise<unknown> {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
  return new Promise((resolve, reject) => {
    const req = request(url, {method: 'DELETE'}, res => {
      res.on('data', resolve);
    });
    req.on('error', reject);
    req.end();
  });
}

// add delay to wait firestore updates
// the reasons why delay is returning response doesn't wait for
// cache update to complete and we cannot access internal promises.
async function tick(ms = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function find(
  collection: CollectionReference,
  entity: CacheEntityRecord,
  limit = 500,
  buildEntityId: BuildEntityId = defaultBuildEntityId
): Promise<QueryDocumentSnapshot[]> {
  const field = entity.id ? 'entityIds' : 'typenames';
  const id = entity.id
    ? buildEntityId(entity.typename, entity.id)
    : entity.typename;
  const snapshots = await collection
    .where(field, 'array-contains', id)
    .limit(limit)
    .get();
  return snapshots.docs;
}

async function exists(
  collection: CollectionReference,
  entity: CacheEntityRecord,
  buildEntityId: BuildEntityId = defaultBuildEntityId
): Promise<boolean> {
  return (await find(collection, entity, 1, buildEntityId)).length > 0;
}

test('should create a default entity id with a number id', () => {
  const entityId = defaultBuildEntityId('User', 1);
  expect(entityId).toEqual('User#1');
});

describe('useResponseCache with Firestore', () => {
  const firestore = new Firestore({projectId});
  const cache = createFirestoreCache({firestore});

  const col = firestore.collection(defaultCollectionPath);

  const typeDefs = /* GraphQL */ `
    type Query {
      users: [User!]!
      user(id: ID!): User
    }

    type Mutation {
      updateUser(id: ID!): User!
    }

    type User {
      id: ID!
      name: String!
      comments: [Comment!]!
    }

    type Comment {
      id: ID!
      text: String!
    }
  `;

  const users = [
    {
      id: 1,
      name: 'User 1',
      comments: [
        {
          id: 1,
          text: 'Comment 1 of User 1',
        },
      ],
    },
    {
      id: 2,
      name: 'User 2',
      comments: [
        {
          id: 2,
          text: 'Comment 2 of User 2',
        },
      ],
    },
    {
      id: 3,
      name: 'User 3',
      comments: [],
    },
  ];

  const userFragment = /* GraphQL */ `
    fragment UserFragment on User {
      id
      name
      comments {
        id
        text
      }
    }
  `;

  beforeEach(async () => {
    jest.useRealTimers();
    await flushAll();
    await tick();
  });

  test('should reuse cache', async () => {
    const spy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          user: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache})],
      schema
    );

    const query1 = /* GraphQL */ `
      query test {
        user(id: 1) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query1);
    await tick();
    await testInstance.execute(query1);
    expect(spy).toHaveBeenCalledTimes(1); // reuse cache

    const query2 = /* GraphQL */ `
      query test {
        user(id: 2) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query2);
    await tick();
    expect(spy).toHaveBeenCalledTimes(2); // cache user 2

    await testInstance.execute(query2);
    await tick();
    expect(spy).toHaveBeenCalledTimes(2); // reuse cache

    await testInstance.execute(query1);
    expect(spy).toHaveBeenCalledTimes(2); // reuse cache
  });

  test('should purge cache on mutation', async () => {
    const usersSpy = jest.fn(() => users);
    const userSpy = jest.fn((_, {id}) => users[id - 1]);
    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: usersSpy,
          user: userSpy,
        },
        Mutation: {
          updateUser(_, {id}) {
            return {id};
          },
        },
      },
    });
    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          cache,
          includeExtensionMetadata: true,
        }),
      ],
      schema
    );

    const usersQuery = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;
    const user3Query = /* GraphQL */ `
      query test {
        user(id: 3) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(usersQuery);
    await tick();
    await testInstance.execute(usersQuery);
    expect(usersSpy).toHaveBeenCalledTimes(1);

    await testInstance.execute(user3Query);
    await tick();
    await testInstance.execute(usersQuery);
    expect(userSpy).toHaveBeenCalledTimes(1);

    // mutate user1
    await testInstance.execute(
      /* GraphQL */ `
        mutation test($id: ID!) {
          updateUser(id: $id) {
            id
          }
        }
      `,
      {
        id: 1,
      }
    );
    await tick();

    await testInstance.execute(usersQuery);
    await tick();
    expect(usersSpy).toHaveBeenCalledTimes(2); // increment

    await testInstance.execute(user3Query);
    await tick();
    expect(userSpy).toHaveBeenCalledTimes(1); // doesn't effect user3
  });

  test('should purge cache on demand (typename+id)', async () => {
    const usersSpy = jest.fn(() => users);
    const userSpy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: usersSpy,
          user: userSpy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache})],
      schema
    );

    const usersQuery = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    const userWihoutCommentQuery = /* GraphQL */ `
      query test {
        user(id: 2) {
          # user2 has a comment but not query
          id
          name
        }
      }
    `;

    const userEmptyCommentQuery = /* GraphQL */ `
      query test {
        user(id: 3) {
          # user3 has no comments
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(usersQuery);
    await tick();
    await testInstance.execute(usersQuery);
    expect(usersSpy).toHaveBeenCalledTimes(1);

    await testInstance.execute(userWihoutCommentQuery);
    await testInstance.execute(userEmptyCommentQuery);
    expect(userSpy).toHaveBeenCalledTimes(2);

    await tick();

    expect(await find(col, {typename: 'User', id: 1})).toHaveLength(1); // users
    expect(await find(col, {typename: 'User', id: 2})).toHaveLength(2); // users, user2
    expect(await find(col, {typename: 'User', id: 3})).toHaveLength(2); // users, user3
    expect(await find(col, {typename: 'User', id: 4})).toHaveLength(0);

    expect(await find(col, {typename: 'Comment', id: 1})).toHaveLength(1); // users
    expect(await find(col, {typename: 'Comment', id: 2})).toHaveLength(1); // users

    await cache.invalidate([{typename: 'Comment', id: 2}]);

    // dropped common cache entry
    expect(await find(col, {typename: 'User', id: 1})).toHaveLength(0);
    expect(await find(col, {typename: 'User', id: 2})).toHaveLength(1); // user2
    expect(await find(col, {typename: 'User', id: 3})).toHaveLength(1); // user3

    // query and create cache
    await testInstance.execute(usersQuery);
    expect(usersSpy).toHaveBeenCalledTimes(2); // incremented

    await tick();

    // from cache
    await testInstance.execute(usersQuery);
    expect(usersSpy).toHaveBeenCalledTimes(2);
  });

  test('should purge cache on demand (typename)', async () => {
    const usersSpy = jest.fn(() => users);
    const userSpy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: usersSpy,
          user: userSpy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache})],
      schema
    );

    const usersQuery = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    const user3Query = /* GraphQL */ `
      query test {
        user(id: 3) {
          # user3 has no comments
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(usersQuery);
    await testInstance.execute(user3Query);
    await tick();
    expect(usersSpy).toHaveBeenCalledTimes(1);
    expect(userSpy).toHaveBeenCalledTimes(1);

    expect(await find(col, {typename: 'User', id: 1})).toHaveLength(1);
    expect(await find(col, {typename: 'User', id: 2})).toHaveLength(1);
    expect(await find(col, {typename: 'User', id: 3})).toHaveLength(2);

    expect(await find(col, {typename: 'Comment', id: 1})).toHaveLength(1);
    expect(await find(col, {typename: 'Comment', id: 2})).toHaveLength(1);

    await cache.invalidate([{typename: 'Comment'}]);

    // dropped common cache entry
    expect(await find(col, {typename: 'User', id: 1})).toHaveLength(0);
    expect(await find(col, {typename: 'User', id: 2})).toHaveLength(0);
    expect(await find(col, {typename: 'User', id: 3})).toHaveLength(1);

    expect(await find(col, {typename: 'Comment', id: 1})).toHaveLength(0);
    expect(await find(col, {typename: 'Comment', id: 2})).toHaveLength(0);

    // query and cache
    await testInstance.execute(usersQuery);
    expect(usersSpy).toHaveBeenCalledTimes(2); // incremented

    await tick();

    // from cache
    await testInstance.execute(usersQuery);
    expect(usersSpy).toHaveBeenCalledTimes(2);
  });

  test('should indicate if the cache was hit or missed', async () => {
    const spy = jest.fn(() => users);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: spy,
        },
        Mutation: {
          updateUser(_, {id}) {
            return {
              id,
            };
          },
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          cache,
          includeExtensionMetadata: true,
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    let queryRes: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    queryRes = await testInstance.execute(query);
    expect(queryRes['extensions']['responseCache']).toEqual({
      hit: false,
      didCache: true,
      ttl: Infinity,
    });

    await tick();

    queryRes = await testInstance.execute(query);
    expect(queryRes['extensions']['responseCache']).toEqual({
      hit: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mutateRes: any = await testInstance.execute(
      /* GraphQL */ `
        mutation test($id: ID!) {
          updateUser(id: $id) {
            id
          }
        }
      `,
      {
        id: 1,
      }
    );
    expect(mutateRes['extensions']['responseCache']).toEqual({
      invalidatedEntities: [{typename: 'User', id: '1'}],
    });
  });

  test('should consider variables when saving response', async () => {
    const spy = jest.fn((_, {limit}) => users.slice(0, limit));

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache})],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query, {limit: 2});
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);

    await testInstance.execute(query, {limit: 2});
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);

    expect(await find(col, {typename: 'User'})).toHaveLength(1);

    await testInstance.execute(query, {limit: 1});
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await find(col, {typename: 'User'})).toHaveLength(2);
  });

  test('should purge response after it expired', async () => {
    const spy = jest.fn(() => users);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache, ttl: 1000})],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query); // query & cache
    await tick();

    await testInstance.execute(query); // reuse cache
    expect(spy).toHaveBeenCalledTimes(1);

    await tick(1500); // wait to expire

    await testInstance.execute(query); // query & recreate
    await tick();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('should cache responses based on session', async () => {
    const spy = jest.fn(() => users);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          cache,
          session(ctx: {sessionId: number}) {
            return ctx.sessionId.toString();
          },
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query, {}, {sessionId: 1});
    await tick();
    await testInstance.execute(query, {}, {sessionId: 1});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await find(col, {typename: 'User', id: 1})).toHaveLength(1);

    await testInstance.execute(query, {}, {sessionId: 2});
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await find(col, {typename: 'User', id: 1})).toHaveLength(2);
  });

  test('should skip cache of ignored types', async () => {
    const usersSpy = jest.fn(() => users);
    const userSpy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: usersSpy,
          user: userSpy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          cache,
          ignoredTypes: ['Comment'],
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query);
    expect(usersSpy).toHaveBeenCalledTimes(1);
    await tick();

    // not cached because contains Comment
    expect(await exists(col, {typename: 'User'})).toBeFalsy();
    expect(await exists(col, {typename: 'User', id: '1'})).toBeFalsy();
    expect(await exists(col, {typename: 'Comment'})).toBeFalsy();
    expect(await exists(col, {typename: 'Comment', id: '2'})).toBeFalsy();

    await testInstance.execute(query);
    expect(usersSpy).toHaveBeenCalledTimes(2);

    await testInstance.execute(/* GraphQL */ `
      # query without comment
      query test {
        user(id: 1) {
          id
          name
        }
      }
    `);
    expect(userSpy).toHaveBeenCalledTimes(1);
    await tick();

    expect(await exists(col, {typename: 'User'})).toBeTruthy();
    expect(await exists(col, {typename: 'User', id: '1'})).toBeTruthy();
    expect(await exists(col, {typename: 'Comment'})).toBeFalsy();
    expect(await exists(col, {typename: 'Comment', id: '2'})).toBeFalsy();
  });

  test('custom ttl per type', async () => {
    const userSpy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          user: userSpy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          cache,
          ttl: 100000,
          ttlPerType: {
            User: 1500, // long
            Comment: 500, //short
          },
        }),
      ],
      schema
    );

    const withCommentQuery = /* GraphQL */ `
      query test {
        user(id: 1) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    const withoutCommentQuery = /* GraphQL */ `
      query test {
        user(id: 3) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    // query & cache
    await Promise.all([
      testInstance.execute(withCommentQuery),
      testInstance.execute(withoutCommentQuery),
    ]);
    expect(userSpy).toHaveBeenCalledTimes(2);
    await tick();

    await testInstance.execute(withCommentQuery); // reuse cache
    await testInstance.execute(withoutCommentQuery); // reuse cache
    expect(userSpy).toHaveBeenCalledTimes(2);

    await tick(1000); // wait to expire Comment

    await testInstance.execute(withoutCommentQuery); // reuse cache
    expect(userSpy).toHaveBeenCalledTimes(2);

    await testInstance.execute(withCommentQuery);
    expect(userSpy).toHaveBeenCalledTimes(3);

    await tick(500); // wait to expire User

    await testInstance.execute(withoutCommentQuery);
    expect(userSpy).toHaveBeenCalledTimes(4);
  });

  test('custom ttl per schema coordinate', async () => {
    const usersSpy = jest.fn(() => users);
    const userSpy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          users: usersSpy,
          user: userSpy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          cache,
          ttl: 100000,
          ttlPerSchemaCoordinate: {
            'Query.users': 500,
            'Query.user': 1500,
          },
        }),
      ],
      schema
    );

    const usersQuery = /* GraphQL */ `
      query test {
        users {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    const user2Query = /* GraphQL */ `
      query test {
        user(id: 2) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    // query & cache
    await Promise.all([
      testInstance.execute(usersQuery),
      testInstance.execute(user2Query),
    ]);
    expect(usersSpy).toHaveBeenCalledTimes(1);
    expect(userSpy).toHaveBeenCalledTimes(1);
    await tick();

    // reuse cache
    await Promise.all([
      testInstance.execute(usersQuery),
      testInstance.execute(user2Query),
    ]);
    expect(usersSpy).toHaveBeenCalledTimes(1);
    expect(userSpy).toHaveBeenCalledTimes(1);
    await tick();

    await tick(500); // wait to expire Query.users

    await Promise.all([
      testInstance.execute(usersQuery),
      testInstance.execute(user2Query),
    ]);
    expect(usersSpy).toHaveBeenCalledTimes(2); // query & cache
    expect(userSpy).toHaveBeenCalledTimes(1); // reuse cache
    await tick();

    await tick(1000); // wait to expire Query.user & 2nd Query.users

    await Promise.all([
      testInstance.execute(usersQuery),
      testInstance.execute(user2Query),
    ]);
    expect(usersSpy).toHaveBeenCalledTimes(3);
    expect(userSpy).toHaveBeenCalledTimes(2);
  });

  test('delete expired caches', async () => {
    const spy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          user: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          cache,
          ttl: 1000,
        }),
      ],
      schema
    );

    const userQuery = /* GraphQL */ `
      query test($id: ID!) {
        user(id: $id) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await Promise.all([
      testInstance.execute(userQuery, {id: 1}),
      testInstance.execute(userQuery, {id: 2}),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    await tick();
    expect(await exists(col, {typename: 'User', id: '1'})).toBeTruthy();
    expect(await exists(col, {typename: 'User', id: '2'})).toBeTruthy();
    expect(await exists(col, {typename: 'User', id: '3'})).toBeFalsy();

    await tick(500);

    // reuse cache
    await Promise.all([
      testInstance.execute(userQuery, {id: 1}), // from cache
      testInstance.execute(userQuery, {id: 2}), // from cache
      testInstance.execute(userQuery, {id: 3}), // query & cache
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
    await tick();
    expect(await exists(col, {typename: 'User', id: '1'})).toBeTruthy();
    expect(await exists(col, {typename: 'User', id: '2'})).toBeTruthy();
    expect(await exists(col, {typename: 'User', id: '3'})).toBeTruthy();

    await tick(500); // wait to expire

    await cache.deleteExpiredCacheEntry();
    await tick();

    expect(await exists(col, {typename: 'User', id: '1'})).toBeFalsy();
    expect(await exists(col, {typename: 'User', id: '2'})).toBeFalsy();
    expect(await exists(col, {typename: 'User', id: '3'})).toBeTruthy();
  });

  test('invalidate large cache entries', async () => {
    const spy = jest.fn((_, {id}) => users[id % 3]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          user: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache})],
      schema
    );

    const query = /* GraphQL */ `
      query test($id: ID!) {
        user(id: $id) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await Promise.all(
      [...Array(1001).keys()].map(i => testInstance.execute(query, {id: i}))
    );
    await tick();
    expect(await find(col, {typename: 'User'}, 1500)).toHaveLength(1001);

    await cache.invalidate([{typename: 'User'}]);

    expect(await find(col, {typename: 'User'}, 1500)).toHaveLength(0);
  }, 20000);

  test('store cache to other collection', async () => {
    const collectionPath = '_responseCache_';
    const cache = createFirestoreCache({firestore, collectionPath});

    const spy = jest.fn((_, {id}) => {
      return users[id - 1];
    });

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          user: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache})],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        user(id: 1) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query);
    await tick();

    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);

    expect(
      await exists(firestore.collection(collectionPath), {typename: 'User'})
    ).toBeTruthy();
    expect(
      await exists(firestore.collection('cache'), {typename: 'User'})
    ).toBeFalsy();

    await cache.invalidate([{typename: 'User'}]);

    expect(
      await exists(firestore.collection(collectionPath), {typename: 'User'})
    ).toBeFalsy();
  });

  test('store cache to subcollection', async () => {
    const collectionPath = 'internal/cache/responseCache';
    const cache = createFirestoreCache({firestore, collectionPath});

    const spy = jest.fn((_, {id}) => users[id - 1]);

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          user: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({session: () => null, cache})],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        user(id: 1) {
          ...UserFragment
        }
      }
      ${userFragment}
    `;

    await testInstance.execute(query);
    await tick();

    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);

    expect(
      await exists(firestore.collection(collectionPath), {typename: 'User'})
    ).toBeTruthy();
    expect(
      await exists(firestore.collection('cache'), {typename: 'User'})
    ).toBeFalsy();

    await cache.invalidate([{typename: 'User'}]);

    expect(
      await exists(firestore.collection(collectionPath), {typename: 'User'})
    ).toBeFalsy();
  });
});
