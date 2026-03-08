package app

import (
	"bytes"

	dbm "github.com/cosmos/cosmos-db"
)

// emptyValFixDB wraps a cosmos-db DB to work around a GoLevelDB quirk:
// GoLevelDB's Get() returns nil for keys stored with empty []byte{} values,
// and Has() (which uses Get() internally) returns false for them.
//
// IAVL's SaveEmptyRoot writes []byte{} for empty trees (e.g., evidence, ibc,
// transfer stores at genesis). This makes those versions invisible to Get/Has,
// causing "version does not exist" panics on node restart.
//
// Fix: when Get() returns nil, fall back to an iterator seek to check whether
// the key truly exists with an empty value.
type emptyValFixDB struct {
	dbm.DB
}

// WrapDBForEmptyValues wraps a database to handle the GoLevelDB empty-value bug.
func WrapDBForEmptyValues(db dbm.DB) dbm.DB {
	return &emptyValFixDB{DB: db}
}

// keyExistsViaIterator performs a single-key iterator seek to check whether
// a key exists in the database. This is used as a fallback when Get() returns
// nil, since GoLevelDB's iterator correctly finds keys with empty values.
func (d *emptyValFixDB) keyExistsViaIterator(key []byte) (bool, error) {
	// Iterator range [key, key+\x00) matches only the exact key.
	end := make([]byte, len(key)+1)
	copy(end, key)
	end[len(key)] = 0x00

	iter, err := d.DB.Iterator(key, end)
	if err != nil {
		return false, err
	}
	defer iter.Close()

	if !iter.Valid() {
		return false, iter.Error()
	}
	return bytes.Equal(iter.Key(), key), iter.Error()
}

// Get overrides the embedded DB's Get to detect empty-value keys.
func (d *emptyValFixDB) Get(key []byte) ([]byte, error) {
	val, err := d.DB.Get(key)
	if err != nil || val != nil {
		return val, err
	}
	// val is nil — either key doesn't exist, or GoLevelDB empty-value bug.
	exists, err := d.keyExistsViaIterator(key)
	if err != nil || !exists {
		return nil, nil
	}
	return []byte{}, nil
}

// Has overrides the embedded DB's Has to detect empty-value keys.
func (d *emptyValFixDB) Has(key []byte) (bool, error) {
	val, err := d.DB.Get(key)
	if err != nil {
		return false, err
	}
	if val != nil {
		return true, nil
	}
	return d.keyExistsViaIterator(key)
}
