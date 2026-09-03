interface NodeRuntimeStartup<TState, TListener> {
  readonly bootstrap: () => TState;
  readonly migrate: (state: TState) => Promise<void>;
  readonly listen: (state: TState) => Promise<TListener>;
}

// The listener is deliberately unreachable until storage opens and every
// migration succeeds. Consequently /api/health cannot report a false success
// for a runtime whose durable state is unavailable or incompatible.
export const startNodeRuntime = async <TState, TListener>(
  startup: NodeRuntimeStartup<TState, TListener>,
): Promise<TListener> => {
  const state = startup.bootstrap();
  await startup.migrate(state);
  return await startup.listen(state);
};
