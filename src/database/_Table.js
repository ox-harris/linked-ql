
/**
 * @imports
 */
import { _isTypeObject, _isNull, _isString, _isNumeric, _isUndefined, _isObject } from '@webqit/util/js/index.js';
import { _from as _arrFrom, _intersect } from '@webqit/util/arr/index.js';
import { _wrapped } from '@webqit/util/str/index.js';

/**
 * ---------------------------
 * Table class
 * ---------------------------
 */				

export default class _Table {
	 
	/**
	 * @inheritdoc
	 */
	constructor(database, tblName, params = {}) {
        this.$ = {
            database,
            schema: database.$.schema.tables.get(tblName),
            params
        };
	}

    /**
     * @property String
     */
    get name() { return this.$.schema.name; }

    /**
     * @property Database
     */
    get database() { return this.$.database; }

    /**
     * @property Object
     */
    get params() { return this.$.params; }

    /**
	 * Returns the table's current savepoint.
	 * 
     * @param Object params
	 * 
	 * @returns Object
     */
    async savepoint(params = {}) {
        if (!this.$.schema.savepoint || params.force) {
            const OBJ_INFOSCHEMA_DB = this.database.client.constructor.OBJ_INFOSCHEMA_DB;
            if ((await this.database.client.databases({ name: OBJ_INFOSCHEMA_DB }))[0]) {
                const result = await this.database.client.query(`SELECT tbl.name_snapshot, db.name_snapshot AS database_snapshot, tbl.columns_snapshot, tbl.constraints_snapshot, tbl.indexes_snapshot, tbl.savepoint_id, db.savepoint_desc, db.savepoint_date FROM ${ OBJ_INFOSCHEMA_DB }.table_savepoints AS tbl RIGHT JOIN ${ OBJ_INFOSCHEMA_DB }.database_savepoints AS db ON db.id = tbl.savepoint_id AND db.current_name = '${ this.database.name }' AND db.rollback_date IS NULL WHERE tbl.current_name = '${ this.name }' ORDER BY db.savepoint_date DESC LIMIT 1`, [], { isStandardSql: true });
                this.$.schema.savepoint = result[0];
            }
        }
        return this.$.schema.savepoint;
    }

	/**
	 * ----------
	 * SCHEMA UTILS
	 * ----------
	 */

	/**
	 * Get Primary Key columns from schema.
	 * 
	 * @returns Array
	 */
	getKeyPathForPrimaryKey() {
		let keyPath = this.$.schema.columns.filter(col => col.primaryKey).map(col => col.name);
		if (!keyPath.length) {
			keyPath = this.$.schema.constraints.find(cons => cons.type === 'PRIMARY KEY')?.columns || [];
		}
		return keyPath;
	}

	/**
	 * Get Index columns from schema.
	 * 
	 * @param String type
	 * 
	 * @returns Array
	 */
	 getKeyPathsForIndex(type) {
		let keyPaths = Object.keys(this.def.schema.columns).filter(name => this.def.schema.columns[name][type]);
		if (this.def.schema.indexes) {
			Object.keys(this.def.schema.indexes).filter(indexName => this.def.schema.indexes[indexName].type === type).forEach(indexName => {
				keyPaths.push(_arrFrom(this.def.schema.indexes[indexName].keyPath));
			});
		}
		return keyPaths;
	}

	/**
	 * ----------
	 * QUERY UTILS
	 * ----------
	 */

	/**
	 * Syncs a cursor.
	 * 
	 * @param Cursor cursor
	 * 
	 * @return Number
	 */
	async syncCursor(cursor) { return await this.putAll(cursor.cache); }

	/**
	 * @inheritdoc
	 */
	async match(rowObj) {
		// -----------
		let primaryKey, existing;
		if (this.def.schema.primaryKey 
		&& (primaryKey = readKeyPath(rowObj, this.def.schema.primaryKey)) 
		&& (existing = await this.get(primaryKey))) {
			return {
				matchingKey: 'PRIMARY_KEY',
				primaryKey,
				row: existing,
			};
		}
		// -----------
		var match, uniqueKeys = Object.keys(this.def.schema.indexes).filter(alias => this.def.schema.indexes[alias].type === 'unique');
		if (uniqueKeys.length) {
			(await this.getAll()).forEach((existingRow, i) => {
				if (match) return;
				uniqueKeys.forEach(constraintName => {
					var keyPath = this.def.schema.indexes[constraintName].keyPath;
					if (existingRow && readKeyPath(rowObj, keyPath) === readKeyPath(existingRow, keyPath)) {
						match = {
							matchingKey: constraintName,
							primaryKey: this.def.schema.primaryKey ? readKeyPath(existingRow, this.def.schema.primaryKey) : i,
							row: {...existingRow},
						};
					}
				});
			});
		}

		return match;
	}
	
	/**
	 * -------------------------------
	 */

	/**
	 * @inheritdoc
	 */
	async addAll(multiValues, columns = [], duplicateKeyCallback = null, forceAutoIncrement = false) {
		const inserts = [], forUpdates = [];
		for (const values of multiValues) {
			let rowObj = values;
			if (Array.isArray(values)) {
				const columnNames = columns.length ? columns : this.$.schema.columns.map(col => col.name);
				if (columnNames.length && columnNames.length !== values.length) {
					throw new Error(`Column/values count mismatch at line ${ multiValues.indexOf(values) }.`);
				}
				rowObj = columnNames.reduce((rowObj, name, i) => ({ ...rowObj, [name]: values[i], }), {});
			}
			// -------------
			this.handleInput(rowObj, true);					
			// -------------
			if (this.shouldMatchInput(rowObj) || duplicateKeyCallback) {
				const match = await this.match(rowObj);
				if (match && duplicateKeyCallback) {
					const duplicateRow = { ...match.row };
					if (duplicateKeyCallback(duplicateRow, rowObj)) {
						forUpdates.push(duplicateRow);
					}
					// The duplicate situation had been handled
					// ...positive or negative
					inserts.push('0');
					continue;
				}
				// We're finally going to add!
				// We must not do this earlier...
				// as "onupdate" rows will erronously take on a new timestamp on this column
				await this.beforeAdd(rowObj, match);
				inserts.push(await this.add(rowObj));
				continue;
			}
			await this.beforeAdd(rowObj);
			inserts.push(await this.add(rowObj));
		}
		// OnDuplicateKey updates
		if (forUpdates.length) { inserts = inserts.concat(await this.putAll(forUpdates)); }
		return inserts.filter((n, i) => n !== 0 && inserts.indexOf(n) === i);
	}
		
	/**
	 * @inheritdoc
	 */
	async beforeAdd(rowObj, match) {
		const timestamp = (new Date).toISOString();
		for (const column of this.$.schema.columns) {
			const columnType = _isObject(column.type) ? column.type.name : column.type;
			if ((columnType === 'datetime' || columnType === 'timestamp') && column.default === 'CURRENT_TIMESTAMP') {
				rowObj[column.name] = timestamp;
			}
		}
	}
	 
	/**
	 * @inheritdoc
	 */
	async putAll(multiRows) {
		const updates = [];
		for (const rowObj of multiRows) {
			// -------------
			this.handleInput(rowObj);					
			// -------------
			if (this.shouldMatchInput(rowObj)) {
				await this.beforePut(rowObj, await this.match(rowObj));
				updates.push(await this.put(rowObj));
				continue;
			}
			await this.beforePut(rowObj);
			updates.push(await this.put(rowObj));
		}
		return updates;
	}
		
	/**
	 * @inheritdoc
	 */
	async beforePut(rowObj, match) {
		if (match && !Object.keys(rowObj).every(key => rowObj[key] === match.row[key])) {
			const timestamp = (new Date).toISOString();
			for (const column of this.$.schema.columns) {
				const columnType = _isObject(column.type) ? column.type.name : column.type;
				if ((columnType === 'datetime' || columnType === 'timestamp') && column.onupdate === 'CURRENT_TIMESTAMP') {
					rowObj[column.name] = timestamp;
				}
			}
		}
	}
	 
	/**
	 * @inheritdoc
	 */
	async deleteAll(multiIDs) {
		const deletes = [];
		for (const primaryKey of multiIDs) {
			deletes.push(this.delete(await this.beforeDelete(primaryKey)));
		}
		return deletes;
	}
		
	/**
	 * @inheritdoc
	 */
	async beforeDelete(primaryKey) {	
		return primaryKey;
	}
	
	/**
	 * -------------------------------
	 */

	/**
	 * @inheritdoc
	 */
	handleInput(rowObj, applyDefaults = false) {
		const rowObjColumns = Object.keys(rowObj);
		const schemaColumns = this.$.schema.columns.map(col => col.name);
		// ------------------
		const unknownFields = rowObjColumns.filter(col => schemaColumns.indexOf(col) === -1);
		if (unknownFields.length) { throw new Error(`Unknown column: ${ unknownFields[0] }`); }
		// ------------------
		schemaColumns.forEach(columnName => {
			const value = rowObj[columnName];
			const column = this.$.schema.columns.find(col => col.name === columnName) || {};
			if (rowObjColumns.includes(columnName)) {
				const columnType = _isObject(column.type) ? column.type.name : column.type;
				// TODO: Validate supplied value
				if (columnType === 'json') {
					if (!_isTypeObject(value) && (!_isString(value) || (!_wrapped(value, '[', ']') && !_wrapped(value, '{', '}')))) {
					}
				} else if (['char', 'tinytext', 'smalltext', 'text', 'bigtext', 'varchar'].includes(columnType)) {
					if (!_isString(value)) {
					}
				} else if (['bit', 'tinyint', 'smallint', 'int', 'bigint', 'decimal', 'number', 'float', 'real'].includes(columnType)) {
					if (!_isNumeric(value)) {
					}
				} else if (['enum', 'set'].includes(columnType)) {
					if (!_isNumeric(value)) {
					}
				} else if (['date', 'datetime', 'timestamp'].includes(columnType)) {
					if (!_isString(value)) {
					}
				}
			} else if (applyDefaults && !_intersect([columnName], this.getKeyPathForPrimaryKey()).length) {
				// DONE: Apply defaults...
				rowObj[columnName] = ('default' in column) && !(['date', 'datetime', 'timestamp'].includes(columnType) && column.default === 'CURRENT_TIMESTAMP') 
					? column.default 
					: null;
			}
			// Non-nullable
			if (column.notNull && (_isNull(rowObj[columnName]) || _isUndefined(rowObj[columnName]))) {
				throw new Error(`Inserting NULL on non-nullable column: ${ columnName }.`);
			}
		});
	}
		
	/**
	 * @inheritdoc
	 */
	shouldMatchInput(rowObj) {
		return this.$.schema.columns.some(column => {
			const columnType = _isObject(column.type) ? column.type.name : column.type;
			return ['datetime', 'timestamp'].includes(columnType) && (
				column.default === 'CURRENT_TIMESTAMP' || column.onupdate === 'CURRENT_TIMESTAMP'
			);
		});
	}
}

/**
 * @AutoIncremen
 */
const readKeyPath = (rowObj, keyPath) => {
	return _arrFrom(keyPath).map(key => rowObj[key]).filter(v => v).join('-');
};
