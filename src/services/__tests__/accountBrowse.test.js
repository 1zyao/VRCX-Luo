import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isBrowse: false,
    AccountSession: vi.fn(function MockAccountSession(userId) {
        this.userId = userId;
        this.login = vi.fn().mockResolvedValue(undefined);
        this.destroy = vi.fn();
    }),
    dbVars: { userPrefix: '' },
    watchState: { isLoggedIn: false }
}));

vi.mock('../../stores/vrcx', () => ({
    useVrcxStore: () => ({ isBrowse: mocks.isBrowse })
}));

vi.mock('../accountSession.js', () => ({
    AccountSession: mocks.AccountSession
}));

vi.mock('../database/index.js', () => ({
    dbVars: mocks.dbVars
}));

vi.mock('../watchState.js', () => ({
    watchState: mocks.watchState
}));

import { accountHub } from '../accountHub';

describe('accountHub.addSession browse-mode guard (bot#5)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isBrowse = false;
        accountHub.removeAllSessions();
    });

    test('browse 模式：addSession 抛错，不建会话', async () => {
        mocks.isBrowse = true;
        const savedEntry = { user: { id: 'usr_b' }, loginParams: {} };

        await expect(accountHub.addSession(savedEntry)).rejects.toThrow(
            'Cannot add secondary session in browse (read-only) mode'
        );
        expect(accountHub.sessions.size).toBe(0);
        expect(mocks.AccountSession).not.toHaveBeenCalled();
    });

    test('collector 模式：addSession 正常建会话并登录', async () => {
        const savedEntry = { user: { id: 'usr_b' }, loginParams: {} };

        await accountHub.addSession(savedEntry);

        expect(mocks.AccountSession).toHaveBeenCalledWith('usr_b');
        expect(accountHub.sessions.has('usr_b')).toBe(true);
    });
});
