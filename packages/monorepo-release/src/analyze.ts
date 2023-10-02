import type { Commit, GrouppedCommits, PackageToRelease } from "./types.js"
import type { Config } from "./config.js"
import { bold } from "yoctocolors"
import { log, execSync } from "./utils.js"
import semver from "semver"
import * as commitlint from "@commitlint/parse"
import gitLog from "git-log-parser"
import streamToArray from "stream-to-array"
import { getPackages } from "@manypkg/get-packages"

export async function analyze(config: Config): Promise<PackageToRelease[]> {
	const { BREAKING_COMMIT_MSG, RELEASE_COMMIT_MSG, RELEASE_COMMIT_TYPES } =
		config

	const packageList = await getPackages(process.cwd())

	log.info("Identifying latest tag...")
	const latestTag = execSync("git describe --tags --abbrev=0", {
		stdio: "pipe",
	})
		.toString()
		.trim()

	log.info(`Latest tag identified: \`${bold(latestTag)}\``)

	log.info()

	log.info("Identifying commits since the latest tag...")

	// TODO: Allow passing in a range of commits to analyze and print the changelog
	const range = `${latestTag}..HEAD`

	// Get the commits since the latest tag
	const commitsSinceLatestTag = await new Promise<Commit[]>(
		(resolve, reject) => {
			const stream = gitLog.parse({ _: range })
			streamToArray(stream, (err: Error, arr: any[]) => {
				if (err) return reject(err)

				Promise.all(
					arr.map(async (d) => {
						// @ts-ignore
						const parsed = await commitlint.default.default(d.subject)

						return { ...d, parsed }
					}),
				).then((res) => resolve(res.filter(Boolean)))
			})
		},
	)

	log.info(
		commitsSinceLatestTag.length,
		`commits found since \`${bold(latestTag)}\``,
	)
	log.debug(
		"Analyzing the following commits:",
		commitsSinceLatestTag.map((c) => `  ${c.subject}`).join("\n"),
	)

	const lastCommit = commitsSinceLatestTag[0]

	if (lastCommit?.parsed.raw === RELEASE_COMMIT_MSG) {
		log.debug("Already released...")
		return []
	}

	log.info()
	log.info("Identifying commits that touched package code...")
	function getChangedFiles(commitSha: string) {
		return execSync(
			`git diff-tree --no-commit-id --name-only -r ${commitSha}`,
			{ stdio: "pipe" },
		)
			.toString()
			.trim()
			.split("\n")
	}
	const packageCommits = commitsSinceLatestTag.filter(({ commit }) => {
		const changedFiles = getChangedFiles(commit.short)
		return packageList.packages.some(({ relativeDir }) =>
			changedFiles.some((changedFile) => changedFile.startsWith(relativeDir)),
		)
	})

	log.info(packageCommits.length, "commits touched package code")

	log.info()

	log.info("Identifying packages that need a new release...")

	const packagesNeedRelease: string[] = []
	const grouppedPackages = packageCommits.reduce(
		(acc, commit) => {
			const changedFilesInCommit = getChangedFiles(commit.commit.short)

			for (const { relativeDir, packageJson } of packageList.packages) {
				const { name: pkg } = packageJson
				if (
					changedFilesInCommit.some((changedFile) =>
						changedFile.startsWith(relativeDir),
					)
				) {
					if (!(pkg in acc)) {
						acc[pkg] = { features: [], bugfixes: [], other: [], breaking: [] }
					}
					const { type } = commit.parsed
					if (RELEASE_COMMIT_TYPES.includes(type)) {
						if (!packagesNeedRelease.includes(pkg)) {
							packagesNeedRelease.push(pkg)
						}
						if (type === "feat") {
							acc[pkg].features.push(commit)
							if (commit.body.includes(BREAKING_COMMIT_MSG)) {
								const [, changesBody] = commit.body.split(BREAKING_COMMIT_MSG)
								acc[pkg].breaking.push({
									...commit,
									body: changesBody.trim(),
								})
							}
						} else acc[pkg].bugfixes.push(commit)
					} else {
						acc[pkg].other.push(commit)
					}
				}
			}
			return acc
		},
		{} as Record<string, GrouppedCommits>,
	)

	if (packagesNeedRelease.length) {
		log.info(
			packagesNeedRelease.length,
			`new release(s) needed: ${packagesNeedRelease.join(", ")}`,
		)
	} else {
		log.info("No packages needed a new release, exiting!")
		process.exit(0)
	}

	log.info()

	const packagesToRelease: PackageToRelease[] = []
	for await (const pkgName of packagesNeedRelease) {
		const commits = grouppedPackages[pkgName]
		const releaseType: semver.ReleaseType = commits.breaking.length
			? "major" // 1.x.x
			: commits.features.length
			? "minor" // x.1.x
			: "patch" // x.x.1

		const { packageJson, relativeDir } = packageList.packages.find(
			(pkg) => pkg.packageJson.name === pkgName,
		)!
		const oldVersion = packageJson.version!
		const newSemVer = semver.parse(semver.inc(oldVersion, releaseType))!

		packagesToRelease.push({
			name: pkgName,
			oldVersion,
			newVersion: `${newSemVer.major}.${newSemVer.minor}.${newSemVer.patch}`,
			commits,
			relativeDir,
		})
	}

	return packagesToRelease
}
