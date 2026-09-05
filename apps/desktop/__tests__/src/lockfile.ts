import { parse } from 'yaml';

const requireObject = (value: unknown, context: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const parseDependencyAssociations = (
  source: string,
  importerName: string,
  context: string,
): Map<string, string> => {
  const lock = requireObject(parse(source), context);
  const importers = requireObject(lock.importers, `${context} importers`);
  const importer = requireObject(importers[importerName], `${context} importer ${importerName}`);
  const associations = new Map<string, string>();
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    if (importer[field] === undefined) continue;
    const dependencies = requireObject(importer[field], `${context} ${field}`);
    for (const [name, descriptorValue] of Object.entries(dependencies)) {
      const descriptor = requireObject(descriptorValue, `${context} dependency ${name}`);
      if (typeof descriptor.version !== 'string') {
        throw new Error(`${context} dependency ${name} has no exact lockfile association`);
      }
      associations.set(name, descriptor.version);
    }
  }
  return associations;
};

export const exactPackageVersion = (association: string, name: string): string => {
  const version = /^(\d+\.\d+\.\d+(?:-[^()]+)?)/.exec(association)?.[1];
  if (version === undefined) throw new Error(`Locked dependency ${name} has non-registry association ${association}`);
  return version;
};
