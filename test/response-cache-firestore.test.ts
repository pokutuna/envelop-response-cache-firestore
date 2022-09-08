import {request} from 'http';
import {createTestkit} from '@envelop/testing';
import {makeExecutableSchema} from '@graphql-tools/schema';
import {useResponseCache} from '@envelop/response-cache';
import {Firestore} from '@google-cloud/firestore';
import {createFirestoreCache, defaultBuildEntityId} from '../src/index';

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

async function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

test('should create a default entity id with a number id', () => {
  const entityId = defaultBuildEntityId('User', 1);
  expect(entityId).toEqual('User#1');
});

describe('useResponseCache with Firestore', () => {
  const firestore = new Firestore({projectId});
  const cache = createFirestoreCache({firestore});

  beforeEach(async () => {
    jest.useRealTimers();
    await flushAll();
  });

  test('should reuse cache', async () => {
    const spy = jest.fn(() => [
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
    ]);
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type Mutation {
          updateUser(id: ID!): User!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
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
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;
    await testInstance.execute(query);
    await tick();
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
