export interface ReleaseRequest {
  event: string;
  refType: string;
  refName: string;
  commit: string;
  requestedCommit: string;
  requestedVersion: string;
  publish: boolean;
}

export interface ReleasePlan {
  tag: string;
  version: string;
  sourceCommit: string;
  publish: boolean;
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;

export const planRelease = (request: ReleaseRequest, desktopVersion: string): ReleasePlan => {
  if (!['push', 'workflow_dispatch'].includes(request.event) || !commitPattern.test(request.commit)) {
    throw new Error('Floway releases require a tag push or manual dispatch and a full source commit SHA');
  }
  if (request.requestedCommit && (!commitPattern.test(request.requestedCommit) || request.requestedCommit !== request.commit)) {
    throw new Error('Floway release checkout must match the requested full source commit SHA');
  }
  const publish = request.event === 'push' || request.publish;
  let version = desktopVersion;
  if (request.event === 'push') {
    if (request.refType !== 'tag' || !request.refName.startsWith('v')) {
      throw new Error('Floway tag releases require a vX.Y.Z tag');
    }
    version = request.refName.slice(1);
  } else if (request.requestedVersion) {
    version = request.requestedVersion;
  }
  if (request.event === 'workflow_dispatch' && publish && (
    request.refType !== 'branch' || request.refName !== 'main' || !request.requestedCommit || !request.requestedVersion
  )) {
    throw new Error('Floway manual publication requires the main workflow, an explicit X.Y.Z version, and a full source commit SHA');
  }
  if (!versionPattern.test(version) || version !== desktopVersion) {
    throw new Error(`Floway release version ${version} must match all checked-in desktop version authorities (${desktopVersion})`);
  }
  return { tag: `v${version}`, version, sourceCommit: request.commit, publish };
};

interface VerificationRun {
  headSha: string;
  status: string;
  conclusion: string;
  event: string;
}

interface PublishedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

export const requirePublishableRelease = (
  plan: ReleasePlan,
  { onMain, existingTagCommit, verification, releases }: {
    onMain: boolean;
    existingTagCommit?: string;
    verification?: VerificationRun;
    releases: readonly PublishedRelease[];
  },
): void => {
  if (!onMain) throw new Error('Floway publication source must belong to main');
  if (existingTagCommit !== undefined && existingTagCommit !== plan.sourceCommit) {
    throw new Error(`Floway tag ${plan.tag} already points to a different source commit`);
  }
  if (verification?.headSha !== plan.sourceCommit || verification.status !== 'completed'
    || verification.conclusion !== 'success' || !['push', 'workflow_dispatch'].includes(verification.event)) {
    throw new Error(`Floway Verify must complete successfully for source commit ${plan.sourceCommit}`);
  }
  const versionParts = plan.version.split('.').map(BigInt);
  for (const release of releases) {
    if (release.tag_name === plan.tag) throw new Error(`Floway release ${plan.tag} already exists`);
    if (release.draft || release.prerelease) continue;
    const version = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
    if (!versionPattern.test(version)) throw new Error(`Floway stable release has an invalid version: ${release.tag_name}`);
    const previous = version.split('.').map(BigInt);
    const difference = versionParts.map((part, index) => part - previous[index]!).find(part => part !== 0n) ?? 0n;
    if (difference <= 0n) throw new Error(`Floway ${plan.tag} must be newer than stable release ${release.tag_name}`);
  }
};
