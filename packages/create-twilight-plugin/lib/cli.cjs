const fs = require('node:fs/promises')
const path = require('node:path')
const { createZip } = require('./zip.cjs')
const { validatePluginManifest } = require('./manifest.cjs')

const TEMPLATE_TYPES = new Set(['tool', 'provider', 'ui-tool', 'theme'])

function packageRoot() {
  return path.resolve(__dirname, '..')
}

function usage() {
  return `create-twilight-plugin

Commands:
  init <directory> --type <tool|provider|ui-tool|theme> [--id <pluginId>] [--name <displayName>]
  pack [directory] [--out <fileOrDirectory>]
  --help
  --version`
}

function readFlag(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function positionalArgs(args) {
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('--')) {
      index += 1
    } else {
      result.push(arg)
    }
  }
  return result
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function displayNameFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

async function copyTemplate(templateDir, targetDir, replacements) {
  const entries = await fs.readdir(templateDir, { withFileTypes: true })
  await fs.mkdir(targetDir, { recursive: true })
  for (const entry of entries) {
    const from = path.join(templateDir, entry.name)
    const fileName = entry.name.endsWith('.tmpl') ? entry.name.slice(0, -5) : entry.name
    const to = path.join(targetDir, fileName)
    if (entry.isDirectory()) {
      await copyTemplate(from, to, replacements)
    } else if (entry.isFile()) {
      let content = await fs.readFile(from, 'utf-8')
      for (const [key, value] of Object.entries(replacements)) {
        content = content.replaceAll(`{{${key}}}`, value)
      }
      await fs.writeFile(to, content, 'utf-8')
    }
  }
}

async function initCommand(args) {
  const targetArg = positionalArgs(args)[0]
  if (!targetArg) throw new Error('init requires a target directory')
  const type = readFlag(args, '--type') ?? 'tool'
  if (!TEMPLATE_TYPES.has(type)) {
    throw new Error(`unsupported template type: ${type}`)
  }
  const targetDir = path.resolve(targetArg)
  const slug = slugify(path.basename(targetDir))
  if (!slug) throw new Error('target directory name must contain letters or numbers')
  const pluginId = readFlag(args, '--id') ?? `com.example.${slug}`
  const pluginName = readFlag(args, '--name') ?? displayNameFromSlug(slug)
  const templateDir = path.join(packageRoot(), 'templates', type)
  await fs.mkdir(path.dirname(targetDir), { recursive: true })
  try {
    const existing = await fs.readdir(targetDir)
    if (existing.length > 0) throw new Error(`target directory is not empty: ${targetDir}`)
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
  }
  await copyTemplate(templateDir, targetDir, {
    pluginId,
    pluginName,
    packageName: slug,
    pluginDescription: `A Twilight Echo ${type} plugin.`
  })
  const manifest = JSON.parse(await fs.readFile(path.join(targetDir, 'plugin.json'), 'utf-8'))
  validatePluginManifest(manifest)
  console.log(`Created ${type} plugin at ${targetDir}`)
}

async function packCommand(args) {
  const rootArg = positionalArgs(args)[0] ?? '.'
  const root = path.resolve(rootArg)
  const manifestPath = path.join(root, 'plugin.json')
  const manifest = validatePluginManifest(JSON.parse(await fs.readFile(manifestPath, 'utf-8')))
  const mainPath = manifest.main ? path.resolve(root, manifest.main) : null
  if (mainPath) await fs.access(mainPath)
  if (manifest.binary) {
    for (const binaryPath of Object.values(manifest.binary)) {
      await fs.access(path.resolve(root, binaryPath))
    }
  }
  const outArg = readFlag(args, '--out')
  const defaultName = `${manifest.id}-${manifest.version}.tep`
  const outputFile = outArg
    ? path.extname(outArg).toLowerCase() === '.tep'
      ? path.resolve(outArg)
      : path.resolve(outArg, defaultName)
    : path.resolve(root, 'dist', defaultName)
  const result = await createZip(root, outputFile)
  console.log(`Packed ${result.fileCount} files to ${result.outputFile}`)
  return result
}

async function runCli(args) {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageRoot(), 'package.json'), 'utf-8')
  )
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(packageJson.version)
    return
  }
  const [command, ...rest] = args
  if (command === 'init') return initCommand(rest)
  if (command === 'pack') return packCommand(rest)
  throw new Error(`unknown command: ${command}`)
}

module.exports = { runCli, initCommand, packCommand }
