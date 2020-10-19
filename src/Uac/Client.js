
/**
 * imports
 */
import Schema from '../Base/Schema.js';
import _arrFrom from '@onephrase/util/arr/from.js';
import _each from '@onephrase/util/obj/each.js';
import Query from './Query.js';

export default class Client {
	
	/**
	 * Creates the UAC logic that sets the value of each field conditionally.
	 *
	 * @param object            USER
	 * @param string            tableName
	 * @param array				columns
	 *
	 * @return Query
	 */
	static select(USER, tableName, columns) {
		var tableNameSplit = tableName.split('.');
		var tableName = tableNameSplit.pop(),
			databaseName = tableNameSplit[0] || 'default';
		columns = _arrFrom(columns);
		if (!columns.length || columns[0] === '*') {
			columns = Object.keys(Schema.schemas[databaseName][tableName].fields);
		}
        // ---------------
        // OBJECT_QUERY
        // ---------------
        var OBJECT_QUERY = new Query(USER, tableName, true);
		// The UAC fields control
		if (0) {
			_each(OBJECT_QUERY.deriveFieldsAccess(columns, 'view'), (field, accessPassExpression) => {
				OBJECT_QUERY.select.push('IF(' + accessPassExpression + ' <> 0, ' + OBJECT_QUERY.alias + '.' + field + ', NULL) AS ' + field);
			});
		} else {
			OBJECT_QUERY.select.push(...columns);
		}
        return OBJECT_QUERY;
	}
		
	/**
	 * Returns the list of all accounts that the given rights can be applied to.
	 *
	 * @param object            USER
	 * @param array	 			organicRights
	 * @param array	 			priorityAccounts
	 *
	 * @return Query
	 */
	static getRelatedAccounts(USER, organicRights, priorityAccounts = []) {
		var accountSchema = Schema.schemas[this.databaseName || 'default'].account;
		var ACCOUNT_QUERY = {
			table: accountSchema,
			alias: 'ACCOUNT',
			select: [],
			where: [],
			orderBy: [],
			toString() {
				return 'SELECT ' + this.select.join(', ')
				+ ' FROM ' + this.table.name + ' AS ' + this.alias
				+ ' RIGHT JOIN (' + this.AUTHOR_USER_RELATIONSHIP_QUERY.query + ') AS ' + this.AUTHOR_USER_RELATIONSHIP_QUERY.alias + ' ON ' + this.AUTHOR_USER_RELATIONSHIP_QUERY.on.join(' AND ')
                + ' WHERE ' + this.where.join(' AND ') 
                + (this.orderBy.length ? ' ORDER BY ' + this.orderBy : '');
			}
		}
		// RIGHT JOIN
		ACCOUNT_QUERY.AUTHOR_USER_RELATIONSHIP_QUERY = {
			query: Query.getAuthorUserRelationshipQuery(USER, false/* groupConcat */),
			alias: 'AUTHOR_USER_RELATIONSHIP',
			on: [
				ACCOUNT_QUERY.alias + '.' + accountSchema.primaryKey + ' = AUTHOR_USER_RELATIONSHIP.' + accountSchema.primaryKey,
				'NOT ISNULL(AUTHOR_USER_RELATIONSHIP.relationship)',
			],
		};
		if (priorityAccounts) {
			// But ensure that the following accounts are listed first, if actually in list
			ACCOUNT_QUERY.select.push('FIND_IN_SET(' + ACCOUNT_QUERY.alias + '.' + accountSchema.primaryKey + ', "' + priorityAccounts.join(',') + '") AS priority');
			ACCOUNT_QUERY.orderBy.push('priority DESC');
		}
		if (organicRights) {
			ACCOUNT_QUERY.where.push('AUTHOR_USER_RELATIONSHIP.relationship in ("' + organicRights.join('", "') + '")');
		}
		return ACCOUNT_QUERY;
	}

	/**
	 * Makes the Query that finds descreet access types
	 * for the current user on this table (or, table row).
	 *
	 * @param object            USER
	 * @param string|array		accesses
	 * @param string|int		overObject			The ID of the subject object.
	 *												(The object author will be basis for organic relationship.)
	 * @param int				orAsRelatedTo		When not overObject!
	 *												(This user ID will be basis for organic relationship.)
	 * @param bool				withFields
	 * @param bool				withActingRights
	 *
	 * @return Query
	 */
	static getAccessesDoc(USER, accesses, overObject = null, orAsRelatedTo = null, withFields = false, withActingRights = false) {
        // Either of the following two arguments are accepted. Not both
		if (overObject && orAsRelatedTo) {
			throw new Error('UAC queries must be either over an object and its author (argument #2), or as related to a specific user (argument #3). But not both!');
		}
        // ---------------
        // OBJECT_QUERY
        // ---------------
        var OBJECT_QUERY = new Query(USER, tableName, objectId || orAsRelatedTo);
        // JOIN: The user's organic rights towards the author
        if (OBJECT_QUERY.AUTHOR_USER_RELATIONSHIP_QUERY) {
            OBJECT_QUERY.AUTHOR_USER_RELATIONSHIP_QUERY.on.push('NOT ISNULL(AUTHOR_USER_RELATIONSHIP.relationship)');
		}
		if (overObject) {
			// The author of the object at the given row in _TABLE
            OBJECT_QUERY.where.push(OBJECT_QUERY.table.primaryKey + ' = ' + overObject);
		} else if (OBJECT_QUERY.table.attributionKey && orAsRelatedTo) {
			// The author specified in orAsRelatedTo or all possible relationships.
			// Whichever the case, _TABLE gets to play no role in this query...
            OBJECT_QUERY.where.push(OBJECT_QUERY.table.attributionKey + ' = ' + orAsRelatedTo);
			OBJECT_QUERY.limit = 1;
        }
        // ---------------
        // DOC
        // ---------------
        if (!accesses.length || accesses === '*') {
            accesses = Client.standardAccesses;
        } else {
            accesses = _arrFrom(accesses);
        }
		var entityJson = [],
			fieldsJson = {},
			fields = withFields ? Object.keys(OBJECT_QUERY.table.fields) : [];
		accesses.forEach(accessType => {
			entityJson.push('JSON_OBJECT("' + accessType + '", COALESCE(' + Query.deriveEntityAccess(accessType, withActingRights) + '))');
			_each(Query.deriveFieldsAccess(fields, accessType, withActingRights), (field, access) => {
                if (!fieldsJson[field]) {
                    fieldsJson[field] = [];
                }
				fieldsJson[field].push('JSON_OBJECT("' + accessType + '", ' + access + ')');
			});
		});
		if (accesses.length > 1) {
			OBJECT_QUERY.select.push('JSON_MERGE(' + entityJson.join(', ') + ') AS uac');
		} else {
			OBJECT_QUERY.select.push(entityJson.join(', ') + ' AS uac');
		}
		if (fieldsJson.length) {
			var allFieldsJson = [];
			_each(fieldsJson, (field, accessesDocs) => {
				if (accesses.length > 1) {
					allFieldsJson.push('JSON_OBJECT("' + field + '", JSON_MERGE(' + accessesDocs.join(', ') + '))');
				} else {
					allFieldsJson.push('JSON_OBJECT("' + field + '", ' + accessesDocs.join(', ') + ')');
				}
			});
			OBJECT_QUERY.select.push('JSON_MERGE(' + allFieldsJson.join(', ') + ') AS fields');
		}
		return OBJECT_QUERY;
	}
};

/**
 * @var array
 */
Client.standardAccesses = [
	'view', 
	'create', 
	'update', 
	'delete', 
	'stats', 
	'use',
];