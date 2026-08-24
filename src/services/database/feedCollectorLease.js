import { adapter } from './adapter/index.js';

const LEASE_KEY = 'feed';
const RENEW_INTERVAL_MS = 10_000;
const LEASE_TTL_MS = 30_000;

const token =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let renewTimer = null;
let ownsLease = false;
let leaseStarted = false;
let leaseDisabled = true;

function now() {
    return Date.now();
}

async function renew() {
    const timestamp = now();
    try {
        await adapter.insert(
            'collector_leases',
            {
                lease_key: LEASE_KEY,
                owner_token: token,
                expires_at: timestamp + LEASE_TTL_MS - 1,
                heartbeat_at: timestamp
            },
            'ignore'
        );
        const affected = await adapter.updateWhere(
            'collector_leases',
            {
                owner_token: token,
                expires_at: timestamp + LEASE_TTL_MS,
                heartbeat_at: timestamp
            },
            'lease_key = @leaseKey AND (owner_token = @ownerToken OR expires_at <= @now)',
            { leaseKey: LEASE_KEY, ownerToken: token, now: timestamp }
        );
        ownsLease = affected > 0;
    } catch (error) {
        ownsLease = false;
        console.error('[feed] collector lease renewal failed', error);
    }
}

export const feedCollectorLease = {
    async start() {
        if (renewTimer) return;
        leaseDisabled = false;
        leaseStarted = true;
        ownsLease = false;
        await renew();
        renewTimer = setInterval(() => {
            renew().catch(() => {});
        }, RENEW_INTERVAL_MS);
    },

    stop() {
        if (renewTimer) {
            clearInterval(renewTimer);
            renewTimer = null;
        }
        leaseStarted = false;
        leaseDisabled = true;
        ownsLease = false;
        adapter
            .deleteWhere(
                'collector_leases',
                'lease_key = @leaseKey AND owner_token = @ownerToken',
                { leaseKey: LEASE_KEY, ownerToken: token }
            )
            .catch(() => {});
    },

    isOwner() {
        return !leaseDisabled && (!leaseStarted || ownsLease);
    }
};
