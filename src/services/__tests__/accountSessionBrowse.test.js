import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isBrowse: false,
    createSecondaryClient: vi.fn(),
    setSecondaryCookies: vi.fn(),
    destroySecondaryClient: vi.fn(),
    modalStore: { prompt: vi.fn() },
    adapter: {
        engineType: 'sqlite',
        insert: vi.fn().mockResolvedValue(1),
        select: vi.fn().mockResolvedValue([]),
        selectOne: vi.fn().mockResolvedValue(null),
        createTable: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../stores/vrcx', () => ({
    useVrcxStore: () => ({ isBrowse: mocks.isBrowse })
}));

vi.mock('../webapi.js', () => ({
    default: {
        createSecondaryClient: (...args) => mocks.createSecondaryClient(...args),
        setSecondaryCookies: (...args) => mocks.setSecondaryCookies(...args),
        destroySecondaryClient: (...args) => mocks.destroySecondaryClient(...args)
    }
}));

vi.mock('../database/adapter/index.js', () => ({
    adapter: mocks.adapter
}));

vi.mock('../../stores/modal', () => ({
    useModalStore: () => mocks.modalStore
}));

vi.mock('../appConfig', () => ({
    AppDebug: {
        endpointDomain: '',
        endpointDomainVrchat: 'https://vrchat.com',
        websocketDomainVrchat: 'wss://pubsub.vrchat.com'
    }
}));

vi.mock('worker-timers', () => ({
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: vi.fn(),
    clearTimeout: () => {}
}));

import { AccountSession } from '../accountSession';

describe('AccountSession.login browse-mode guard (bot#5)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isBrowse = false;
    });

    test('browse 模式：login 早退，不建 secondary client', async () => {
        mocks.isBrowse = true;
        const session = new AccountSession('usr_c');

        await session.login({
            user: { id: 'usr_c' },
            loginParams: { username: 'c', password: 'p' }
        });

        expect(mocks.createSecondaryClient).not.toHaveBeenCalled();
    });

    test('collector 模式：login 建 secondary client', async () => {
        const session = new AccountSession('usr_c');
        session._requestRaw = vi.fn().mockResolvedValue({ id: 'usr_c' });
        session._initTables = vi.fn().mockResolvedValue(undefined);
        session._loadFriends = vi.fn().mockResolvedValue(undefined);
        session._connectWS = vi.fn();
        session._startPolling = vi.fn();

        await session.login({
            user: { id: 'usr_c' },
            loginParams: { username: 'c', password: 'p' }
        });

        expect(mocks.createSecondaryClient).toHaveBeenCalledWith('usr_c');
    });
});
