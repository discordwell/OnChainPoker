package app

import (
	"bytes"
	"crypto/sha256"

	dbm "github.com/cosmos/cosmos-db"

	"cosmossdk.io/store/cachemulti"
	"cosmossdk.io/store/dbadapter"
	iavlstore "cosmossdk.io/store/iavl"
	"cosmossdk.io/store/rootmulti"
	storetypes "cosmossdk.io/store/types"
)

// emptyTreeHash is the SHA-256 hash of an empty IAVL tree.
var emptyTreeHash = func() []byte {
	h := sha256.Sum256(nil)
	return h[:]
}()

// queryMultiStore wraps rootmulti.Store and overrides CacheMultiStoreWithVersion
// to work around a GoLevelDB quirk: GoLevelDB returns nil on Get for keys
// saved with an empty value ([]byte{}), and Has returns false for them.
//
// IAVL's SaveEmptyRoot writes []byte{} for empty trees (evidence, ibc, transfer
// at genesis), making those versions invisible to Get/Has while iterators still
// find them. This breaks CacheMultiStoreWithVersion for any store whose tree
// is empty at the requested height.
//
// The fix: when GetImmutable fails and the CommitInfo shows an empty-tree hash
// for that store, substitute a MemDB-backed dummy instead of returning an error.
type queryMultiStore struct {
	*rootmulti.Store
}

func (qms *queryMultiStore) CacheMultiStoreWithVersion(version int64) (storetypes.CacheMultiStore, error) {
	cachedStores := make(map[storetypes.StoreKey]storetypes.CacheWrapper)

	for _, key := range qms.Store.StoreKeysByName() {
		store := qms.Store.GetStoreByName(key.Name())
		if store == nil {
			continue
		}

		var cacheStore storetypes.CacheWrapper

		switch store.GetStoreType() {
		case storetypes.StoreTypeIAVL:
			raw := qms.Store.GetCommitKVStore(key)
			iavl, ok := raw.(*iavlstore.Store)
			if !ok {
				cacheStore = store
				break
			}

			immutable, err := iavl.GetImmutable(version)
			if err != nil {
				if qms.isEmptyStoreAtVersion(key.Name(), version) {
					cacheStore = dbadapter.Store{DB: dbm.NewMemDB()}
				} else {
					return nil, err
				}
			} else {
				cacheStore = immutable
			}

		default:
			cacheStore = store
		}

		cachedStores[key] = cacheStore
	}

	return cachemulti.NewStore(cachedStores, nil, nil), nil
}

// isEmptyStoreAtVersion returns true if the store either didn't exist at the
// given version or had an empty IAVL tree (hash equals SHA256 of empty string).
func (qms *queryMultiStore) isEmptyStoreAtVersion(storeName string, version int64) bool {
	cInfo, err := qms.Store.GetCommitInfo(version)
	if err != nil {
		return false // can't get commit info (pruned?) → let caller return the original error
	}
	for _, si := range cInfo.StoreInfos {
		if si.Name == storeName {
			return bytes.Equal(si.CommitId.Hash, emptyTreeHash)
		}
	}
	return true // not found in commit info → didn't exist at this version
}
