import type {Cache} from '@envelop/response-cache';
import type {
  DocumentData,
  Firestore,
  FirestoreDataConverter,
  Query,
  QueryDocumentSnapshot,
} from '@google-cloud/firestore';
import {FieldPath, Timestamp} from '@google-cloud/firestore';
import chunk from 'lodash.chunk';

export type BuildEntityId = (typename: string, id: number | string) => string;

export type BuildOperationResultCacheKey = (responseId: string) => string;

export type FirestoreCacheParameters = {
  /**
   * Firestore instance to store cache
   * @see @google-cloud/firestore https://www.npmjs.com/package/@google-cloud/firestore
   */
  firestore: Firestore;

  /**
   * Firestore collection path to store cache entries
   * @defaultValue "responseCache"
   */
  collectionPath?: string;

  /**
   * Customize entity id string conversion for invalidation (usually not required to use)
   * If typename#id is substring of other typename, you have to set this.
   * @defaultValue ({typename, id}) => `${typename}#${id}`
   */
  buildEntityId?: BuildEntityId;
};

export type CacheFirestore = Cache & {
  deleteExpiredCacheEntry(): Promise<unknown>;
};

type CacheEntry = {
  payload: string; // JSON
  expireAt: Date | null;
  typenames: string[]; // Set of typename
  entityIds: string[]; // Set of entityId
};

type CacheEntryFS = Omit<CacheEntry, 'expireAt'> & {expireAt: Timestamp};

const converter: FirestoreDataConverter<CacheEntry> = {
  toFirestore(entry: CacheEntry): DocumentData {
    return entry;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot<CacheEntryFS>): CacheEntry {
    const data = snapshot.data();
    return {
      ...data,
      expireAt: data.expireAt ? data.expireAt.toDate() : null,
    };
  },
};

export const defaultCollectionPath = 'responseCache';

export function createFirestoreCache(
  params: FirestoreCacheParameters
): CacheFirestore {
  const db = params.firestore;
  const collectionPath = params.collectionPath ?? defaultCollectionPath;
  const collection = db.collection(collectionPath).withConverter(converter);

  const buildEntityId = params?.buildEntityId ?? defaultBuildEntityId;

  return {
    async set(id, data, entities, ttl) {
      const ref = collection.doc(id);

      const typenames = new Set<string>();
      const entityIds = new Set<string>();
      for (const {typename, id} of entities) {
        typenames.add(typename);
        if (id) {
          entityIds.add(buildEntityId(typename, id));
        }
      }

      const entry: CacheEntry = {
        payload: JSON.stringify(data),
        expireAt: isFinite(ttl) ? new Date(Date.now() + ttl) : null,
        typenames: Array.from(typenames),
        entityIds: Array.from(entityIds),
      };

      await ref.set(entry);
    },

    async get(id) {
      const ref = collection.doc(id);
      const snapshot = await ref.get();
      if (!snapshot.exists) return undefined;

      const entry = snapshot.data();
      if (!entry) return undefined;

      const {payload, expireAt} = entry;
      if (expireAt && expireAt.getTime() <= Date.now()) {
        ref.delete();
        return undefined;
      }
      return JSON.parse(payload);
    },

    async invalidate(entities) {
      const typenames = new Set<string>();
      const entityIds = new Set<string>();
      for (const {typename, id} of entities) {
        if (!id) {
          typenames.add(typename);
        }
        if (id && !typenames.has(typename)) {
          entityIds.add(buildEntityId(typename, id));
        }
      }

      // delete by typename
      await chunk(Array.from(typenames), 10).reduce((prev, chunk) => {
        return prev.then(async () => {
          const query = collection
            .where('typenames', 'array-contains-any', chunk)
            .orderBy(FieldPath.documentId(), 'asc');
          return deleteAll(db, query, s => s.id);
        });
      }, Promise.resolve());

      // delete by entity
      await chunk(Array.from(entityIds), 10).reduce((prev, chunk) => {
        return prev.then(async () => {
          const query = collection
            .where('entityIds', 'array-contains-any', chunk)
            .orderBy(FieldPath.documentId(), 'asc');
          return deleteAll(db, query, s => s.id);
        });
      }, Promise.resolve());
    },

    async deleteExpiredCacheEntry() {
      const query = collection
        .where('expireAt', '<', new Date())
        .orderBy('expireAt', 'asc');
      return deleteAll(db, query, s => s.data()?.expireAt);
    },
  };
}

async function deleteAll(
  db: Firestore,
  query: Query,
  afterFunc: (snapshot: QueryDocumentSnapshot) => DocumentData[string]
) {
  return new Promise<void>((resolve, reject) =>
    deleteQueryBatch(db, query, afterFunc, resolve).catch(reject)
  );
}

async function deleteQueryBatch(
  db: Firestore,
  query: Query,
  afterFunc: (snapshot: QueryDocumentSnapshot) => DocumentData[string],
  resolve: () => void,
  after?: DocumentData[string]
) {
  const q = query.limit(500);
  const snapshot = await (after ? q.startAfter(after) : q).get();
  const batchSize = snapshot.size;
  if (batchSize === 0) {
    resolve();
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  const last = snapshot.docs[snapshot.docs.length - 1];
  process.nextTick(() => {
    deleteQueryBatch(db, query, afterFunc, resolve, afterFunc(last));
  });
}

export const defaultBuildEntityId: BuildEntityId = (typename, id) =>
  `${typename}#${id}`;
