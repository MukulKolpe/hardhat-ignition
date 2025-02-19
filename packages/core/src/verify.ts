import { analyze } from "@nomicfoundation/solidity-analyzer";
import path from "path";

import { IgnitionError } from "./errors";
import { builtinChains } from "./internal/chain-config";
import { FileDeploymentLoader } from "./internal/deployment-loader/file-deployment-loader";
import { ERRORS } from "./internal/errors-list";
import { encodeDeploymentArguments } from "./internal/execution/abi";
import { loadDeploymentState } from "./internal/execution/deployment-state-helpers";
import { DeploymentState } from "./internal/execution/types/deployment-state";
import { ExecutionResultType } from "./internal/execution/types/execution-result";
import {
  DeploymentExecutionState,
  ExecutionSateType,
  ExecutionStatus,
} from "./internal/execution/types/execution-state";
import { assertIgnitionInvariant } from "./internal/utils/assertions";
import { findExecutionStatesByType } from "./internal/views/find-execution-states-by-type";
import { Artifact, BuildInfo, CompilerInput } from "./types/artifact";
import {
  ChainConfig,
  SourceToLibraryToAddress,
  VerifyResult,
} from "./types/verify";

/**
 * Retrieve the information required to verify all contracts from a deployment on Etherscan.
 *
 * @param deploymentDir - the file directory of the deployment
 * @param customChains - an array of custom chain configurations
 *
 * @beta
 */
export async function* getVerificationInformation(
  deploymentDir: string,
  customChains: ChainConfig[] = [],
  includeUnrelatedContracts = false
): AsyncGenerator<VerifyResult> {
  const deploymentLoader = new FileDeploymentLoader(deploymentDir);

  const deploymentState = await loadDeploymentState(deploymentLoader);

  if (deploymentState === undefined) {
    throw new IgnitionError(ERRORS.VERIFY.UNINITIALIZED_DEPLOYMENT, {
      deploymentDir,
    });
  }

  const chainConfig = resolveChainConfig(deploymentState, customChains);

  const deploymentExStates = findExecutionStatesByType(
    ExecutionSateType.DEPLOYMENT_EXECUTION_STATE,
    deploymentState
  ).filter((exState) => exState.status === ExecutionStatus.SUCCESS);

  if (deploymentExStates.length === 0) {
    throw new IgnitionError(ERRORS.VERIFY.NO_CONTRACTS_DEPLOYED, {
      deploymentDir,
    });
  }

  for (const exState of deploymentExStates) {
    const verifyInfo = await convertExStateToVerifyInfo(
      exState,
      deploymentLoader,
      includeUnrelatedContracts
    );

    const verifyResult: VerifyResult = [chainConfig, verifyInfo];

    yield verifyResult;
  }
}

function resolveChainConfig(
  deploymentState: DeploymentState,
  customChains: ChainConfig[]
) {
  // implementation note:
  // if a user has set a custom chain with the same chainId as a builtin chain,
  // the custom chain will be used instead of the builtin chain
  const chainConfig = [...customChains, ...builtinChains].find(
    (c) => c.chainId === deploymentState.chainId
  );

  if (chainConfig === undefined) {
    throw new IgnitionError(ERRORS.VERIFY.UNSUPPORTED_CHAIN, {
      chainId: deploymentState.chainId,
    });
  }

  return chainConfig;
}

function getImportSourceNames(
  sourceName: string,
  buildInfo: BuildInfo
): string[] {
  const contractSource = buildInfo.input.sources[sourceName].content;
  const { imports } = analyze(contractSource);

  const importSources = imports.map((i) => {
    if (/^\.\.?[\/|\\]/.test(i)) {
      return path.join(path.dirname(sourceName), i).replaceAll("\\", "/");
    }

    return i;
  });

  return [
    ...importSources,
    ...importSources.flatMap((i) => getImportSourceNames(i, buildInfo)),
  ];
}

async function convertExStateToVerifyInfo(
  exState: DeploymentExecutionState,
  deploymentLoader: FileDeploymentLoader,
  includeUnrelatedContracts: boolean = false
) {
  const [buildInfo, artifact] = await Promise.all([
    deploymentLoader.readBuildInfo(exState.artifactId),
    deploymentLoader.loadArtifact(exState.artifactId),
  ]);

  const { contractName, constructorArgs, libraries } = exState;

  assertIgnitionInvariant(
    exState.result !== undefined &&
      exState.result.type === ExecutionResultType.SUCCESS,
    `Deployment execution state ${exState.id} should have a successful result to retrieve address`
  );

  const sourceCode = prepareInputBasedOn(buildInfo, artifact, libraries);

  if (!includeUnrelatedContracts) {
    const sourceNames = [
      artifact.sourceName,
      ...getImportSourceNames(artifact.sourceName, buildInfo),
    ];

    for (const source of Object.keys(sourceCode.sources)) {
      if (!sourceNames.includes(source)) {
        delete sourceCode.sources[source];
      }
    }
  }

  const verifyInfo = {
    address: exState.result.address,
    compilerVersion: buildInfo.solcLongVersion.startsWith("v")
      ? buildInfo.solcLongVersion
      : `v${buildInfo.solcLongVersion}`,
    sourceCode: JSON.stringify(sourceCode),
    name: `${artifact.sourceName}:${contractName}`,
    args: encodeDeploymentArguments(artifact, constructorArgs),
  };

  return verifyInfo;
}

function prepareInputBasedOn(
  buildInfo: BuildInfo,
  artifact: Artifact,
  libraries: Record<string, string>
): CompilerInput {
  const sourceToLibraryAddresses = resolveLibraryInfoForArtifact(
    artifact,
    libraries
  );

  if (sourceToLibraryAddresses === null) {
    return buildInfo.input;
  }

  const { input } = buildInfo;
  input.settings.libraries = sourceToLibraryAddresses;

  return input;
}

function resolveLibraryInfoForArtifact(
  artifact: Artifact,
  libraries: Record<string, string>
): SourceToLibraryToAddress | null {
  const sourceToLibraryToAddress: SourceToLibraryToAddress = {};

  for (const [sourceName, refObj] of Object.entries(artifact.linkReferences)) {
    for (const [libName] of Object.entries(refObj)) {
      sourceToLibraryToAddress[sourceName] ??= {};

      const libraryAddress = libraries[libName];

      assertIgnitionInvariant(
        libraryAddress !== undefined,
        `Could not find address for library ${libName}`
      );

      sourceToLibraryToAddress[sourceName][libName] = libraryAddress;
    }
  }

  if (Object.entries(sourceToLibraryToAddress).length === 0) {
    return null;
  }

  return sourceToLibraryToAddress;
}
