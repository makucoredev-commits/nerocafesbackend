/**
 * Returns the database selected by the Mongo connection string.
 *
 * MongoDB uses `test` when a connection string has no database segment.  Keep
 * that behaviour explicit because branch routing must use the same database as
 * the main Mongoose connection.
 */
export function getPrimaryDatabaseName(uri = process.env.MONGODB_URI) {
  const configuredName = process.env.MONGODB_DB_NAME?.trim();
  if (configuredName) return configuredName;

  try {
    const databaseName = new URL(uri).pathname.replace(/^\/+|\/+$/g, '');
    return databaseName || 'test';
  } catch {
    return 'test';
  }
}
