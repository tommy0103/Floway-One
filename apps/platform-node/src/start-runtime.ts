interface NodeRuntimeStartup<TDatabase, TListener> {
  readonly bootstrap: () => { db: TDatabase };
  readonly migrate: (db: TDatabase) => Promise<void>;
  readonly listen: (db: TDatabase) => Promise<TListener>;
}

// The listener is deliberately unreachable until storage opens and every
// migration succeeds. Consequently /api/health cannot report a false success
// for a runtime whose durable state is unavailable or incompatible.
export const startNodeRuntime = async <TDatabase, TListener>(
  startup: NodeRuntimeStartup<TDatabase, TListener>,
): Promise<TListener> => {
  const { db } = startup.bootstrap();
  await startup.migrate(db);
  return await startup.listen(db);
};
