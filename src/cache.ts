import type {Cache} from '@envelop/response-cache';
import type {
  DocumentData,
  Firestore,
  FirestoreDataConverter,
  Query,
  QueryDocumentSnapshot,
  Timestamp,
} from '@google-cloud/firestore';
import {FieldPath} from '@google-cloud/firestore';
import chunk from 'lodash.chunk';

export type BuildEntityId = (typename: string, id: number | string) => string;

export type BuildOperationResultCacheKey = (responseId: string) => string;

export type FirestoreCacheParameters = {
  /**
   *
   */
  firestore: Firestore;

  /**
   * Firestore collection path
   */
  collectionPath: string;

  /**
   *
   */
  buildEntityId?: BuildEntityId;
};

export type CacheFirestore = Cache & {
  deleteExpiredCacheEntry(): Promise<unknown>;
};

type CacheEntry = {
  payload: string; // JSON
  expiredAt: Date;
  typenames: string[]; // Set of typename
  entityIds: string[]; // Set of entityId
};

type CacheEntryFS = Omit<CacheEntry, 'expiredAt'> & {expiredAt: Timestamp};

const converter: FirestoreDataConverter<CacheEntry> = {
  toFirestore(entry: CacheEntry): DocumentData {
    return entry;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot<CacheEntryFS>): CacheEntry {
    const data = snapshot.data();
    return {
      ...data,
      expiredAt: data.expiredAt.toDate(),
    };
  },
};

export function createFirestoreCache(
  params: FirestoreCacheParameters
): CacheFirestore {
  const db = params.firestore;
  const collection = db
    .collection(params.collectionPath)
    .withConverter(converter);

  const buildEntityId = params?.buildEntityId ?? defaultBuildEntityId;

  return {
    async set(id, data, entities, ttl) {
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
        expiredAt: new Date(Date.now() + ttl),
        typenames: Array.from(typenames),
        entityIds: Array.from(entityIds),
      };

      const doc = collection.doc(id);
      await doc.set(entry);
    },

    async get(id) {
      const doc = collection.doc(id);
      const snapshot = await doc.get();
      if (!snapshot.exists) return undefined;

      const entry = snapshot.data();
      if (!entry) return undefined;

      const {payload, expiredAt} = entry;
      if (expiredAt.getTime() <= Date.now()) {
        doc.delete();
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
          const query = collection.where(
            'typenames',
            'array-contains-any',
            chunk
          );
          return deleteAll(db, query);
        });
      }, Promise.resolve());

      // delete by entity
      await chunk(Array.from(entityIds), 10).reduce((prev, chunk) => {
        return prev.then(async () => {
          const query = collection.where(
            'entityIds',
            'array-contains-any',
            chunk
          );
          return deleteAll(db, query);
        });
      }, Promise.resolve());
    },

    async deleteExpiredCacheEntry() {
      const query = collection.where('expiredAt', '<', Date.now());
      return deleteAll(db, query);
    },
  };
}

async function deleteAll(db: Firestore, query: Query) {
  return new Promise<void>((resolve, reject) =>
    deleteQueryBatch(db, query, resolve).catch(reject)
  );
}

async function deleteQueryBatch(
  db: Firestore,
  query: Query,
  resolve: () => void,
  afterId?: string
) {
  const snapshot = await query
    .orderBy(FieldPath.documentId(), 'asc')
    .startAfter(afterId)
    .limit(500)
    .get();
  const batchSize = snapshot.size;
  if (batchSize === 0) {
    resolve();
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  const lastId = snapshot.docs[snapshot.docs.length - 1].id;
  process.nextTick(() => {
    deleteQueryBatch(db, query, resolve, lastId);
  });
}

export const defaultBuildEntityId: BuildEntityId = (typename, id) =>
  `${typename}#${id}`;
