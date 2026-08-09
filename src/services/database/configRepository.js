import { adapter } from './adapter/index.js';

// Once-per-process guard for the missing-`configs`-table degrade warning
// (browse mode + uninitialized database, design §4.4 / MEDIUM-4).
let _configsTableMissingWarned = false;

function transformKey(key) {
    return `config:${String(key).toLowerCase()}`;
}

class ConfigRepository {
    async init() {
        await adapter.createTable('configs', [
            { name: 'key', type: 'TEXT', constraints: 'PRIMARY KEY' },
            { name: 'value', type: 'TEXT' }
        ]);
    }

    async remove(key) {
        const _key = transformKey(key);
        await adapter.delete('configs', { key: _key });
    }

    async getString(key, defaultValue = null) {
        const _key = transformKey(key);
        let row;
        try {
            row = await adapter.selectOne('configs', ['value'], {
                key: _key
            });
        } catch (e) {
            // Browse mode may read a database that has never been initialized
            // by a collector run — degrade to the default value (warn once)
            // instead of crashing; all other errors keep the original
            // rethrow behaviour.
            // MySQL 变体: MySqlConnector 报 `Table 'db.configs' doesn't exist`
            // (MEDIUM-2, qa);SQLite `no such table` / PG `does not exist` 一并覆盖。
            if (
                e instanceof Error &&
                /no such table|doesn'?t exist|does not exist/i.test(e.message)
            ) {
                if (!_configsTableMissingWarned) {
                    _configsTableMissingWarned = true;
                    console.warn(
                        `[browse] configs 表不存在，读取降级为默认值: ${key}`
                    );
                }
                return defaultValue;
            }
            throw e;
        }
        const value = row ? row[0] : undefined;
        if (value === null || value === undefined || value === 'undefined') {
            return defaultValue;
        }
        return value;
    }

    async setString(key, value) {
        const _key = transformKey(key);
        const _value = String(value);
        await adapter.insert(
            'configs',
            { key: _key, value: _value },
            'replace'
        );
    }

    async getBool(key, defaultValue = null) {
        const value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        return value === 'true';
    }

    async setBool(key, value) {
        await this.setString(key, value ? 'true' : 'false');
    }

    async getInt(key, defaultValue = null) {
        let value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        value = parseInt(value, 10);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    async setInt(key, value) {
        await this.setString(key, value);
    }

    async getFloat(key, defaultValue = null) {
        let value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        value = parseFloat(value);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    async setFloat(key, value) {
        await this.setString(key, value);
    }

    async getObject(key, defaultValue = null) {
        let value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        try {
            value = JSON.parse(value);
        } catch {
            // ignore JSON parse errors
        }
        if (value !== Object(value)) {
            return defaultValue;
        }
        return value;
    }

    async setObject(key, value) {
        await this.setString(key, JSON.stringify(value));
    }

    async getArray(key, defaultValue = null) {
        const value = await this.getObject(key, null);
        if (Array.isArray(value) === false) {
            return defaultValue;
        }
        return value;
    }

    async setArray(key, value) {
        await this.setObject(key, value);
    }
}

var self = new ConfigRepository();

export { self as default, ConfigRepository, transformKey };
