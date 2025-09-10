import * as core from '@actions/core'
import * as github from '@actions/github'
import type {RestEndpointMethodTypes} from '@octokit/rest'
import flatten from 'lodash/flatten'
import convertPath from '@stdlib/utils-convert-path'
import mm from 'micromatch'
import * as path from 'path'
import {setOutputsAndGetModifiedAndChangedFilesStatus} from './changedFilesOutput'
import {DiffResult} from './commitSha'
import {Inputs} from './inputs'
import {
  canDiffCommits,
  getAllChangedFiles,
  getDirnameMaxDepth,
  getDirNamesIncludeFilesPattern,
  getFilteredChangedFiles,
  gitRenamedFiles,
  gitSubmoduleDiffSHA,
  isWindows,
  jsonOutput,
  setArrayOutput
} from './utils'

// Helper function to replace spaces with hyphens in file paths
const replaceSpacesInPath = (filePath: string): string => {
  return filePath.replace(/\s+/g, '-')
}

// Helper function to replace spaces with hyphens in file path arrays
const replaceSpacesInPaths = (filePaths: string[]): string[] => {
  return filePaths.map(replaceSpacesInPath)
}

export const processChangedFiles = async ({
  filePatterns,
  allDiffFiles,
  inputs,
  yamlFilePatterns,
  workingDirectory
}: {
  filePatterns: string[]
  allDiffFiles: ChangedFiles
  inputs: Inputs
  yamlFilePatterns: Record<string, string[]>
  workingDirectory?: string
}): Promise<void> => {
  if (filePatterns.length > 0) {
    core.startGroup('changed-files-patterns')
    const allFilteredDiffFiles = await getFilteredChangedFiles({
      allDiffFiles,
      filePatterns
    })
    core.debug(
      `All filtered diff files: ${JSON.stringify(allFilteredDiffFiles)}`
    )
    await setOutputsAndGetModifiedAndChangedFilesStatus({
      allDiffFiles,
      allFilteredDiffFiles,
      inputs,
      filePatterns,
      workingDirectory
    })
    core.info('All Done!')
    core.endGroup()
  }

  if (Object.keys(yamlFilePatterns).length > 0) {
    const modifiedKeys: string[] = []
    const changedKeys: string[] = []

    for (const key of Object.keys(yamlFilePatterns)) {
      core.startGroup(`changed-files-yaml-${key}`)
      const allFilteredDiffFiles = await getFilteredChangedFiles({
        allDiffFiles,
        filePatterns: yamlFilePatterns[key]
      })
      core.debug(
        `All filtered diff files for ${key}: ${JSON.stringify(
          allFilteredDiffFiles
        )}`
      )
      const {anyChanged, anyModified} =
        await setOutputsAndGetModifiedAndChangedFilesStatus({
          allDiffFiles,
          allFilteredDiffFiles,
          inputs,
          filePatterns: yamlFilePatterns[key],
          outputPrefix: key,
          workingDirectory
        })
      if (anyModified) {
        modifiedKeys.push(key)
      }
      if (anyChanged) {
        changedKeys.push(key)
      }

      core.info('All Done!')
      core.endGroup()
    }

    await setArrayOutput({
      key: 'modified_keys',
      inputs,
      value: modifiedKeys
    })

    await setArrayOutput({
      key: 'changed_keys',
      inputs,
      value: changedKeys
    })
  }

  if (filePatterns.length === 0 && Object.keys(yamlFilePatterns).length === 0) {
    core.startGroup('changed-files-all')
    await setOutputsAndGetModifiedAndChangedFilesStatus({
      allDiffFiles,
      allFilteredDiffFiles: allDiffFiles,
      inputs,
      workingDirectory
    })
    core.info('All Done!')
    core.endGroup()
  }
}

export const getRenamedFiles = async ({
  inputs,
  workingDirectory,
  diffSubmodule,
  diffResult,
  submodulePaths
}: {
  inputs: Inputs
  workingDirectory: string
  diffSubmodule: boolean
  diffResult: DiffResult
  submodulePaths: string[]
}): Promise<{paths: string; count: string}> => {
  const renamedFiles = await gitRenamedFiles({
    cwd: workingDirectory,
    sha1: diffResult.previousSha,
    sha2: diffResult.currentSha,
    diff: diffResult.diff,
    oldNewSeparator: inputs.oldNewSeparator
  })

  if (diffSubmodule) {
    for (const submodulePath of submodulePaths) {
      const submoduleShaResult = await gitSubmoduleDiffSHA({
        cwd: workingDirectory,
        parentSha1: diffResult.previousSha,
        parentSha2: diffResult.currentSha,
        submodulePath,
        diff: diffResult.diff
      })

      const submoduleWorkingDirectory = path.join(
        workingDirectory,
        submodulePath
      )

      if (submoduleShaResult.currentSha && submoduleShaResult.previousSha) {
        let diff = '...'

        if (
          !(await canDiffCommits({
            cwd: submoduleWorkingDirectory,
            sha1: submoduleShaResult.previousSha,
            sha2: submoduleShaResult.currentSha,
            diff
          }))
        ) {
          let message = `Unable to use three dot diff for: ${submodulePath} submodule. Falling back to two dot diff. You can set 'fetch_additional_submodule_history: true' to fetch additional submodule history in order to use three dot diff`
          if (inputs.fetchAdditionalSubmoduleHistory) {
            message = `To fetch additional submodule history for: ${submodulePath} you can increase history depth using 'fetch_depth' input`
          }
          core.info(message)
          diff = '..'
        }

        const submoduleRenamedFiles = await gitRenamedFiles({
          cwd: submoduleWorkingDirectory,
          sha1: submoduleShaResult.previousSha,
          sha2: submoduleShaResult.currentSha,
          diff,
          oldNewSeparator: inputs.oldNewSeparator,
          isSubmodule: true,
          parentDir: submodulePath
        })
        renamedFiles.push(...submoduleRenamedFiles)
      }
    }
  }

  // Replace spaces with hyphens in renamed files
  const processedRenamedFiles = replaceSpacesInPaths(renamedFiles)

  if (inputs.json) {
    return {
      paths: jsonOutput({value: processedRenamedFiles, shouldEscape: inputs.escapeJson}),
      count: processedRenamedFiles.length.toString()
    }
  }

  return {
    paths: processedRenamedFiles.join(inputs.oldNewFilesSeparator),
    count: processedRenamedFiles.length.toString()
  }
}

export enum ChangeTypeEnum {
  Added = 'A',
  Copied = 'C',
  Deleted = 'D',
  Modified = 'M',
  Renamed = 'R',
  TypeChanged = 'T',
  Unmerged = 'U',
  Unknown = 'X'
}

export type ChangedFiles = {
  [key in ChangeTypeEnum]: string[]
}

export const getAllDiffFiles = async ({
  workingDirectory,
  diffSubmodule,
  diffResult,
  submodulePaths,
  outputRenamedFilesAsDeletedAndAdded,
  fetchAdditionalSubmoduleHistory,
  failOnInitialDiffError,
  failOnSubmoduleDiffError
}: {
  workingDirectory: string
  diffSubmodule: boolean
  diffResult: DiffResult
  submodulePaths: string[]
  outputRenamedFilesAsDeletedAndAdded: boolean
  fetchAdditionalSubmoduleHistory: boolean
  failOnInitialDiffError: boolean
  failOnSubmoduleDiffError: boolean
}): Promise<ChangedFiles> => {
  const files = await getAllChangedFiles({
    cwd: workingDirectory,
    sha1: diffResult.previousSha,
    sha2: diffResult.currentSha,
    diff: diffResult.diff,
    outputRenamedFilesAsDeletedAndAdded,
    failOnInitialDiffError
  })

  if (diffSubmodule) {
    for (const submodulePath of submodulePaths) {
      const submoduleShaResult = await gitSubmoduleDiffSHA({
        cwd: workingDirectory,
        parentSha1: diffResult.previousSha,
        parentSha2: diffResult.currentSha,
        submodulePath,
        diff: diffResult.diff
      })

      const submoduleWorkingDirectory = path.join(
        workingDirectory,
        submodulePath
      )

      if (submoduleShaResult.currentSha && submoduleShaResult.previousSha) {
        let diff = '...'

        if (
          !(await canDiffCommits({
            cwd: submoduleWorkingDirectory,
            sha1: submoduleShaResult.previousSha,
            sha2: submoduleShaResult.currentSha,
            diff
          }))
        ) {
          let message = `Set 'fetch_additional_submodule_history: true' to fetch additional submodule history for: ${submodulePath}`
          if (fetchAdditionalSubmoduleHistory) {
            message = `To fetch additional submodule history for: ${submodulePath} you can increase history depth using 'fetch_depth' input`
          }
          core.warning(message)
          diff = '..'
        }

        const submoduleFiles = await getAllChangedFiles({
          cwd: submoduleWorkingDirectory,
          sha1: submoduleShaResult.previousSha,
          sha2: submoduleShaResult.currentSha,
          diff,
          isSubmodule: true,
          parentDir: submodulePath,
          outputRenamedFilesAsDeletedAndAdded,
          failOnSubmoduleDiffError
        })

        for (const changeType of Object.keys(
          submoduleFiles
        ) as ChangeTypeEnum[]) {
          if (!files[changeType]) {
            files[changeType] = []
          }
          files[changeType].push(...submoduleFiles[changeType])
        }
      }
    }
  }

  // Replace spaces with hyphens in all file paths
  for (const changeType of Object.keys(files) as ChangeTypeEnum[]) {
    files[changeType] = replaceSpacesInPaths(files[changeType])
  }

  return files
}

function* getFilePaths({
  inputs,
  filePaths,
  dirNamesIncludeFilePatterns
}: {
  inputs: Inputs
  filePaths: string[]
  dirNamesIncludeFilePatterns: string[]
}): Generator<string> {
  for (const filePath of filePaths) {
    let processedPath = filePath
    
    if (inputs.dirNames) {
      if (dirNamesIncludeFilePatterns.length > 0) {
        const isWin = isWindows()
        const matchOptions = {dot: true, windows: isWin, noext: true}
        if (mm.isMatch(filePath, dirNamesIncludeFilePatterns, matchOptions)) {
          yield replaceSpacesInPath(filePath)
        }
      }
      processedPath = getDirnameMaxDepth({
        relativePath: filePath,
        dirNamesMaxDepth: inputs.dirNamesMaxDepth,
        excludeCurrentDir: inputs.dirNamesExcludeCurrentDir
      })
    }
    
    yield replaceSpacesInPath(processedPath)
  }
}

function* getChangeTypeFilesGenerator({
  inputs,
  changedFiles,
  changeTypes
}: {
  inputs: Inputs
  changedFiles: ChangedFiles
  changeTypes: ChangeTypeEnum[]
}): Generator<string> {
  const dirNamesIncludeFilePatterns = getDirNamesIncludeFilesPattern({inputs})
  core.debug(
    `Dir names include file patterns: ${JSON.stringify(
      dirNamesIncludeFilePatterns
    )}`
  )

  for (const changeType of changeTypes) {
    const filePaths = changedFiles[changeType] || []
    for (const filePath of getFilePaths({
      inputs,
      filePaths,
      dirNamesIncludeFilePatterns
    })) {
      if (isWindows() && inputs.usePosixPathSeparator) {
        yield replaceSpacesInPath(convertPath(filePath, 'mixed'))
      } else {
        yield replaceSpacesInPath(filePath)
      }
    }
  }
}

export const getChangeTypeFiles = async ({
  inputs,
  changedFiles,
  changeTypes
}: {
  inputs: Inputs
  changedFiles: ChangedFiles
  changeTypes: ChangeTypeEnum[]
}): Promise<{paths: string[] | string; count: string}> => {
  const files = [
    ...new Set(getChangeTypeFilesGenerator({inputs, changedFiles, changeTypes}))
  ].filter(Boolean)

  const paths = inputs.json ? files : files.join(inputs.separator)

  return {
    paths,
    count: files.length.toString()
  }
}

function* getAllChangeTypeFilesGenerator({
  inputs,
  changedFiles
}: {
  inputs: Inputs
  changedFiles: ChangedFiles
}): Generator<string> {
  const dirNamesIncludeFilePatterns = getDirNamesIncludeFilesPattern({inputs})
  core.debug(
    `Dir names include file patterns: ${JSON.stringify(
      dirNamesIncludeFilePatterns
    )}`
  )

  const filePaths = flatten(Object.values(changedFiles))

  for (const filePath of getFilePaths({
    inputs,
    filePaths,
    dirNamesIncludeFilePatterns
  })) {
    if (isWindows() && inputs.usePosixPathSeparator) {
      yield replaceSpacesInPath(convertPath(filePath, 'mixed'))
    } else {
      yield replaceSpacesInPath(filePath)
    }
  }
}

export const getAllChangeTypeFiles = async ({
  inputs,
  changedFiles
}: {
  inputs: Inputs
  changedFiles: ChangedFiles
}): Promise<{paths: string[] | string; count: string}> => {
  const files = [
    ...new Set(getAllChangeTypeFilesGenerator({inputs, changedFiles}))
  ].filter(Boolean)

  const paths = inputs.json ? files : files.join(inputs.separator)

  return {
    paths,
    count: files.length.toString()
  }
}

export const getChangedFilesFromGithubAPI = async ({
  inputs
}: {
  inputs: Inputs
}): Promise<ChangedFiles> => {
  const octokit = github.getOctokit(inputs.token, {
    baseUrl: inputs.apiUrl
  })
  const changedFiles: ChangedFiles = {
    [ChangeTypeEnum.Added]: [],
    [ChangeTypeEnum.Copied]: [],
    [ChangeTypeEnum.Deleted]: [],
    [ChangeTypeEnum.Modified]: [],
    [ChangeTypeEnum.Renamed]: [],
    [ChangeTypeEnum.TypeChanged]: [],
    [ChangeTypeEnum.Unmerged]: [],
    [ChangeTypeEnum.Unknown]: []
  }

  core.info('Getting changed files from GitHub API...')

  const options = octokit.rest.pulls.listFiles.endpoint.merge({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: github.context.payload.pull_request?.number,
    per_page: 100
  })

  const paginatedResponse =
    await octokit.paginate<
      RestEndpointMethodTypes['pulls']['listFiles']['response']['data'][0]
    >(options)

  core.info(`Found ${paginatedResponse.length} changed files from GitHub API`)
  const statusMap: Record<string, ChangeTypeEnum> = {
    added: ChangeTypeEnum.Added,
    removed: ChangeTypeEnum.Deleted,
    modified: ChangeTypeEnum.Modified,
    renamed: ChangeTypeEnum.Renamed,
    copied: ChangeTypeEnum.Copied,
    changed: ChangeTypeEnum.TypeChanged,
    unchanged: ChangeTypeEnum.Unmerged
  }

  for await (const item of paginatedResponse) {
    const changeType: ChangeTypeEnum =
      statusMap[item.status] || ChangeTypeEnum.Unknown

    if (changeType === ChangeTypeEnum.Renamed) {
      if (inputs.outputRenamedFilesAsDeletedAndAdded) {
        changedFiles[ChangeTypeEnum.Deleted].push(replaceSpacesInPath(item.previous_filename || ''))
        changedFiles[ChangeTypeEnum.Added].push(replaceSpacesInPath(item.filename))
      } else {
        changedFiles[ChangeTypeEnum.Renamed].push(replaceSpacesInPath(item.filename))
      }
    } else {
      changedFiles[changeType].push(replaceSpacesInPath(item.filename))
    }
  }

  return changedFiles
}
