import { create } from 'zustand';

import type { ParsedTag } from '@/core/tagParser';
import { apiRequest, isApiConfigured } from './api';
import { getConfig } from './configStore';
import { getDb } from './db';
import { log } from './logger';

export type SyncState = 'pending' | 'synced' | 'pendingDelete' | 'error';

export interface Pairing {
  id: number;
  barcode: string;
  barcodeType: string;
  tagKey: string;
  tagUid: string;
  tagName: string;
  createdAt: number;
  syncState: SyncState;
  remoteId: string | null;
  lastError: string | null;
}

interface Row {
  id: number;
  barcode: string;
  barcode_type: string;
  tag_key: string;
  tag_uid: string;
  tag_name: string;
  created_at: number;
  sync_state: SyncState;
  remote_id: string | null;
  last_error: string | null;
}

const fromRow = (r: Row): Pairing => ({
  id: r.id,
  barcode: r.barcode,
  barcodeType: r.barcode_type,
  tagKey: r.tag_key,
  tagUid: r.tag_uid,
  tagName: r.tag_name,
  createdAt: r.created_at,
  syncState: r.sync_state,
  remoteId: r.remote_id,
  lastError: r.last_error,
});

export const usePairings = create<{ items: Pairing[] }>(() => ({ items: [] }));

async function reload() {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    "SELECT * FROM pairings WHERE sync_state != 'pendingDelete' ORDER BY created_at DESC",
  );
  usePairings.setState({ items: rows.map(fromRow) });
}

let syncing = false;

/**
 * Pairings are stored locally first, then synced to the backend (POST /pairings, DELETE /pairings/:id).
 * Without a configured API they stay local ("pending").
 */
export const pairingService = {
  reload,

  async findByTag(tagKey: string): Promise<Pairing | null> {
    const db = await getDb();
    const r = await db.getFirstAsync<Row>(
      "SELECT * FROM pairings WHERE tag_key = ? AND sync_state != 'pendingDelete'",
      tagKey,
    );
    return r ? fromRow(r) : null;
  },

  async pair(barcode: string, barcodeType: string, tag: ParsedTag) {
    const existing = await this.findByTag(tag.key);
    if (existing) throw new Error(`${tag.name} is already paired with ${existing.barcode}. Unpair it first.`);
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO pairings (barcode, barcode_type, tag_key, tag_uid, tag_name, created_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      barcode,
      barcodeType,
      tag.key,
      tag.uid,
      tag.name,
      Date.now(),
    );
    await reload();
    void this.sync();
  },

  async unpair(id: number) {
    const db = await getDb();
    const r = await db.getFirstAsync<Row>('SELECT * FROM pairings WHERE id = ?', id);
    if (!r) return;
    if (!r.remote_id) await db.runAsync('DELETE FROM pairings WHERE id = ?', id);
    else await db.runAsync("UPDATE pairings SET sync_state = 'pendingDelete' WHERE id = ?", id);
    await reload();
    void this.sync();
  },

  async sync() {
    if (syncing || !isApiConfigured()) return;
    syncing = true;
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<Row>(
        "SELECT * FROM pairings WHERE sync_state IN ('pending', 'error', 'pendingDelete') ORDER BY id",
      );
      for (const r of rows) {
        try {
          if (r.sync_state === 'pendingDelete') {
            await apiRequest('DELETE', `/pairings/${encodeURIComponent(r.remote_id ?? '')}`);
            await db.runAsync('DELETE FROM pairings WHERE id = ?', r.id);
          } else {
            const res = await apiRequest<{ id: string | number }>('POST', '/pairings', {
              barcode: r.barcode,
              barcodeType: r.barcode_type,
              tagId: r.tag_key,
              tagUid: r.tag_uid,
              tagName: r.tag_name,
              gatewayId: getConfig().other.gatewayId,
              pairedAt: new Date(r.created_at).toISOString(),
            });
            await db.runAsync(
              "UPDATE pairings SET sync_state = 'synced', remote_id = ?, last_error = NULL WHERE id = ?",
              String(res?.id ?? ''),
              r.id,
            );
          }
        } catch (e) {
          const msg = (e as Error).message;
          log.warn('pairing', `sync failed: ${msg}`);
          if (r.sync_state !== 'pendingDelete') {
            await db.runAsync("UPDATE pairings SET sync_state = 'error', last_error = ? WHERE id = ?", msg, r.id);
          }
        }
      }
    } finally {
      syncing = false;
      await reload();
    }
  },
};
