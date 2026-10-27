import type { IExtensionContext } from 'heybox-mod-api'

const GAME_ID = 3883570
const GAME_NAME = 'Invokyr'
const STEAM_APP_ID = String(GAME_ID)
const EXECUTABLE = 'Invokyr.exe'
const GAME_ROOT_TARGET = '{gamePath}'

const MOD_TYPE_BEPINEX_RUNTIME = `${GAME_ID}-bepinex6-il2cpp-runtime`
const MOD_TYPE_BEPINEX_PLUGIN = `${GAME_ID}-bepinex6-il2cpp-plugin`
const BEPINEX_REQUIREMENT_MOD_ID = '127953'

const REQUIRED_GAME_FILES = [
  EXECUTABLE,
  'GameAssembly.dll',
  'UnityPlayer.dll',
  'Invokyr_Data/il2cpp_data/Metadata/global-metadata.dat',
]

const REQUIRED_BEPINEX_FILES = [
  'winhttp.dll',
  'doorstop_config.ini',
  'BepInEx/core/BepInEx.Unity.IL2CPP.dll',
]

type Instruction = { type: 'copy'; source: string; destination: string }
type InstallerResult = { instructions: Instruction[]; modType: string }

interface RequirementStatus {
  installed: boolean
  gamePath: string
  requirements: Array<Record<string, unknown>>
}

function normalizeArchivePath(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(\.\/)+/, '')
  if (!normalized || /^[a-z]:\//i.test(normalized) || normalized.includes('://')) return ''
  const pathParts = normalized.split('/').filter(Boolean)
  if (pathParts.some((part) => part === '.' || part === '..')) return ''
  return pathParts.join('/')
}

function parts(value: string): string[] {
  const normalized = normalizeArchivePath(value)
  return normalized ? normalized.split('/') : []
}

function basename(value: string): string {
  return parts(value).at(-1) ?? ''
}

function joinArchivePath(...segments: string[]): string {
  return segments
    .flatMap((segment) => parts(segment))
    .join('/')
}

function findAnchor(value: string, anchor: string): number {
  return parts(value).findIndex((part) => part.toLowerCase() === anchor.toLowerCase())
}

function isGameArchive(gameId: string | number): boolean {
  return String(gameId) === STEAM_APP_ID || Number(gameId) === GAME_ID
}

function hasExactPath(files: string[], expected: string[]): boolean {
  return files.some((file) => {
    const fileParts = parts(file)
    return fileParts.length === expected.length
      && expected.every((part, index) => fileParts[index]?.toLowerCase() === part.toLowerCase())
  })
}

function findBepInExRuntimeRoot(files: string[]): string[] | null {
  const normalizedFiles = files.map(normalizeArchivePath).filter(Boolean)
  for (const winhttpFile of normalizedFiles) {
    if (basename(winhttpFile).toLowerCase() !== 'winhttp.dll') continue
    const root = parts(winhttpFile).slice(0, -1)
    if (
      hasExactPath(normalizedFiles, [...root, 'doorstop_config.ini'])
      && hasExactPath(normalizedFiles, [...root, 'BepInEx', 'core', 'BepInEx.Unity.IL2CPP.dll'])
    ) return root
  }
  return null
}

function isBepInExRuntime(files: string[]): boolean {
  return findBepInExRuntimeRoot(files) !== null
}

function isRuntimeDll(file: string): boolean {
  const fileParts = parts(file).map((part) => part.toLowerCase())
  const bepinexIndex = fileParts.indexOf('bepinex')
  if (bepinexIndex >= 0 && fileParts[bepinexIndex + 1] === 'core') return true
  return fileParts.includes('dotnet') || basename(file).toLowerCase() === 'winhttp.dll'
}

function isBepInExPlugin(files: string[]): boolean {
  if (isBepInExRuntime(files)) return false
  return files.some((file) => {
    const normalized = normalizeArchivePath(file)
    return normalized.toLowerCase().endsWith('.dll') && !isRuntimeDll(normalized)
  })
}

function testBepInExRuntime(files: string[], gameId: string | number) {
  return Promise.resolve({
    supported: isGameArchive(gameId) && isBepInExRuntime(files),
    requiredFiles: [],
  })
}

function testBepInExPlugin(files: string[], gameId: string | number) {
  return Promise.resolve({
    supported: isGameArchive(gameId) && isBepInExPlugin(files),
    requiredFiles: [],
  })
}

function installBepInExRuntime(files: string[]): InstallerResult {
  const root = findBepInExRuntimeRoot(files)
  if (!root) return { instructions: [], modType: MOD_TYPE_BEPINEX_RUNTIME }

  const instructions: Instruction[] = []
  for (const source of files) {
    const normalized = normalizeArchivePath(source)
    if (!normalized) continue
    const sourceParts = parts(normalized)
    const belongsToRoot = root.every(
      (part, index) => sourceParts[index]?.toLowerCase() === part.toLowerCase(),
    )
    if (!belongsToRoot || sourceParts.length <= root.length) continue
    instructions.push({
      type: 'copy',
      source,
      destination: sourceParts.slice(root.length).join('/'),
    })
  }
  return { instructions, modType: MOD_TYPE_BEPINEX_RUNTIME }
}

const PACKAGE_METADATA_FILES = new Set([
  'changelog.md',
  'icon.png',
  'license',
  'license.md',
  'manifest.json',
  'readme',
  'readme.md',
  'readme.txt',
])

function pluginDestination(source: string): string | null {
  const normalized = normalizeArchivePath(source)
  if (!normalized) return null
  const sourceParts = parts(normalized)

  const bepinexIndex = findAnchor(normalized, 'BepInEx')
  if (bepinexIndex >= 0) {
    const area = sourceParts[bepinexIndex + 1]?.toLowerCase()
    if (area === 'plugins' || area === 'patchers' || area === 'config') {
      return sourceParts.slice(bepinexIndex).join('/')
    }
    return null
  }

  const pluginsIndex = findAnchor(normalized, 'plugins')
  if (pluginsIndex >= 0) {
    const relative = sourceParts.slice(pluginsIndex + 1).join('/')
    return relative ? joinArchivePath('BepInEx/plugins', relative) : null
  }

  const fileName = basename(normalized).toLowerCase()
  if (PACKAGE_METADATA_FILES.has(fileName) || /\.(md|png|jpe?g|webp)$/i.test(fileName)) return null
  return joinArchivePath('BepInEx/plugins', normalized)
}

function installBepInExPlugin(files: string[]): InstallerResult {
  const instructions: Instruction[] = []
  for (const source of files) {
    const destination = pluginDestination(source)
    if (destination) instructions.push({ type: 'copy', source, destination })
  }
  return { instructions, modType: MOD_TYPE_BEPINEX_PLUGIN }
}

async function fileExists(context: IExtensionContext, filePath: string): Promise<boolean> {
  if (!filePath) return false
  try {
    return Boolean((await context.api.util.fs.stat(filePath))?.isFile)
  } catch {
    return false
  }
}

async function isGameRoot(context: IExtensionContext, candidate: string): Promise<boolean> {
  if (!candidate) return false
  const checks = await Promise.all(REQUIRED_GAME_FILES.map(
    (file) => fileExists(context, context.api.util.path.join(candidate, file)),
  ))
  return checks.every(Boolean)
}

async function findGamePath(context: IExtensionContext): Promise<string | undefined> {
  const game = await context.api.util.GameStoreHelper.findByAppId(STEAM_APP_ID)
  const steamPath = game?.gamePath ?? ''
  const candidates = [
    steamPath,
    steamPath ? context.api.util.path.join(steamPath, 'Invokyr') : '',
    steamPath ? context.api.util.path.join(steamPath, 'Invokyr', 'Invokyr') : '',
  ].filter(Boolean)

  for (const candidate of [...new Set(candidates)]) {
    if (await isGameRoot(context, candidate)) return candidate
  }
  return undefined
}

async function getBepInExStatus(context: IExtensionContext, gamePath?: string) {
  const resolvedGamePath = String(gamePath || await findGamePath(context) || '')
  const missingFiles: string[] = []

  if (resolvedGamePath) {
    for (const file of REQUIRED_BEPINEX_FILES) {
      if (!await fileExists(context, context.api.util.path.join(resolvedGamePath, file))) {
        missingFiles.push(file)
      }
    }
  } else {
    missingFiles.push(...REQUIRED_BEPINEX_FILES)
  }

  const initialized = missingFiles.length === 0
    && await fileExists(context, context.api.util.path.join(resolvedGamePath, 'BepInEx/LogOutput.log'))

  return {
    installed: missingFiles.length === 0,
    initialized,
    gamePath: resolvedGamePath,
    missingFiles,
  }
}

function getBepInExRequirement() {
  return {
    key: 'invokyr-bepinex6-il2cpp',
    name: 'BepInEx 6 IL2CPP',
    modId: BEPINEX_REQUIREMENT_MOD_ID,
    mod_id: BEPINEX_REQUIREMENT_MOD_ID,
    modType: MOD_TYPE_BEPINEX_RUNTIME,
    openModDetailDialog: false,
    requirement: 'enabled',
  }
}

async function getRequirementStatus(
  context: IExtensionContext,
  gamePath?: string,
): Promise<RequirementStatus> {
  const status = await getBepInExStatus(context, gamePath)
  const requirements: Array<Record<string, unknown>> = []
  if (!status.installed) requirements.push(getBepInExRequirement())

  return {
    installed: requirements.length === 0,
    gamePath: status.gamePath,
    requirements,
  }
}

async function getExtensionRequiredMods(context: IExtensionContext, gamePath?: string) {
  const status = await getRequirementStatus(context, gamePath)
  if (status.installed) return status

  return {
    ...status,
    code: 'EXTENSION_REQUIRED_MODS_MISSING',
    requirement: {
      code: 'EXTENSION_REQUIRED_MODS_MISSING',
      requirements: status.requirements,
    },
  }
}

async function main(context: IExtensionContext): Promise<boolean> {
  context.registerGame({
    id: GAME_ID,
    name: GAME_NAME,
    executable: EXECUTABLE,
    queryPath: () => findGamePath(context),
    requiredFiles: [EXECUTABLE],
    setup: async (discovery: any) => getExtensionRequiredMods(
      context,
      String(discovery?.path || discovery?.gamePath || ''),
    ),
    localModFeatures: [
      {
        modId: Number(BEPINEX_REQUIREMENT_MOD_ID),
        marked: true,
        mark: { type: 'prerequisite', label: '前置模组' },
      },
    ],
    environment: { SteamAPPId: STEAM_APP_ID },
    details: { steamAppId: GAME_ID },
  })

  context.registerModType(
    MOD_TYPE_BEPINEX_RUNTIME,
    40,
    (gameId: string | number) => isGameArchive(gameId),
    () => GAME_ROOT_TARGET,
    () => Promise.resolve(false),
    { name: 'BepInEx 6 IL2CPP Runtime' },
  )
  context.registerModType(
    MOD_TYPE_BEPINEX_PLUGIN,
    30,
    (gameId: string | number) => isGameArchive(gameId),
    () => GAME_ROOT_TARGET,
    () => Promise.resolve(false),
    { name: 'BepInEx 6 IL2CPP Plugin' },
  )

  context.registerInstaller(
    MOD_TYPE_BEPINEX_RUNTIME,
    40,
    testBepInExRuntime,
    (files: string[]) => installBepInExRuntime(files),
  )
  context.registerInstaller(
    MOD_TYPE_BEPINEX_PLUGIN,
    30,
    testBepInExPlugin,
    (files: string[]) => installBepInExPlugin(files),
  )

  context.registerExtensionAction(GAME_ID, 'getBepInExStatus', () => getBepInExStatus(context))
  context.registerExtensionAction(
    GAME_ID,
    'getExtensionRequiredMods',
    () => getExtensionRequiredMods(context),
  )
  return true
}

export default main
