import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { XMLParser } from 'fast-xml-parser';

function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function extractDatasetFromFeature(feature: string): string | undefined {
	const idx = feature.indexOf('|');
	if (idx < 0) {
		return undefined;
	}
	const data = decodeHtmlEntities(feature.substring(idx + 1).trim());
	return data ? data : undefined;
}

function sanitizeIdPart(input: string): string {
	return input
		.replace(/[\s\r\n\t]+/g, ' ')
		.replace(/[^A-Za-z0-9_.-]/g, '_')
		.slice(0, 80);
}

function collectTestcasesFromNode(node: any, out: any[]) {
	if (!node || typeof node !== 'object') {
		return;
	}

	const tc = node.testcase;
	if (tc) {
		out.push(...(Array.isArray(tc) ? tc : [tc]));
	}

	const ts = node.testsuite;
	if (ts) {
		const suites = Array.isArray(ts) ? ts : [ts];
		for (const s of suites) {
			collectTestcasesFromNode(s, out);
		}
	}
}

function getCodeceptionOutputDir(workspaceRoot: string): string {
	const candidates = [
		path.join(workspaceRoot, 'codeception.yml'),
		path.join(workspaceRoot, 'codeception.yaml'),
		path.join(workspaceRoot, 'codeception.dist.yml'),
		path.join(workspaceRoot, 'codeception.dist.yaml')
	];

	let content: string | undefined;
	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) {
				content = fs.readFileSync(p, 'utf8');
				break;
			}
		} catch {
			// ignore
		}
	}
	if (!content) {
		return path.join(workspaceRoot, 'tests', '_output');
	}

	const lines = content.split(/\r?\n/);
	let inPaths = false;
	let pathsIndent: number | undefined;

	for (const line of lines) {
		if (/^\s*#/.test(line)) {
			continue;
		}

		const pathsMatch = line.match(/^(\s*)paths\s*:\s*$/);
		if (pathsMatch) {
			inPaths = true;
			pathsIndent = pathsMatch[1].length;
			continue;
		}
		if (!inPaths) {
			continue;
		}
		const indentMatch = line.match(/^(\s*)\S/);
		if (indentMatch && pathsIndent !== undefined && indentMatch[1].length <= pathsIndent) {
			// left the paths block
			inPaths = false;
			pathsIndent = undefined;
			continue;
		}

		const outputMatch = line.match(/^\s*output\s*:\s*(.+)\s*$/);
		if (outputMatch) {
			let value = outputMatch[1].trim();
			value = value.replace(/^['"]|['"]$/g, '');
			if (!value) {
				break;
			}
			return resolveWorkspacePath(workspaceRoot, value);
		}
	}

	return path.join(workspaceRoot, 'tests', '_output');
}

type ReportType = 'junit' | 'phpunit' | 'html';

function normalizeReportTypes(input: unknown): ReportType[] {
	const raw = Array.isArray(input) ? input : [];
	const unique = new Set<ReportType>();
	for (const v of raw) {
		const first = String(v).trim().split(/\s+/)[0] || '';
		const s = first.toLowerCase();
		if (s === 'junit' || s === 'phpunit' || s === 'html') {
			unique.add(s);
		}
	}
	return [...unique];
}

function getDefaultReportFileName(format: 'junit' | 'phpunit'): string {
	return format === 'phpunit' ? 'phpunit-report.xml' : 'report.xml';
}

function getSelfAndAncestors(item: vscode.TestItem): vscode.TestItem[] {
	const chain: vscode.TestItem[] = [];
	let cur: vscode.TestItem | undefined = item;
	while (cur) {
		chain.push(cur);
		cur = cur.parent;
	}
	return chain;
}

function getAnyUri(item: vscode.TestItem): vscode.Uri | undefined {
	if (item.uri) {
		return item.uri;
	}
	for (const [, child] of item.children) {
		const u = getAnyUri(child);
		if (u) {
			return u;
		}
	}
	return undefined;
}

function getSelfAndDescendants(item: vscode.TestItem): vscode.TestItem[] {
	const out: vscode.TestItem[] = [];
	const stack: vscode.TestItem[] = [item];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (!cur) {
			continue;
		}
		out.push(cur);
		for (const [, child] of cur.children) {
			stack.push(child);
		}
	}
	return out;
}

function getSelfAndAncestorsUntil(item: vscode.TestItem, untilInclusive: vscode.TestItem): vscode.TestItem[] {
	const chain: vscode.TestItem[] = [];
	let cur: vscode.TestItem | undefined = item;
	while (cur) {
		chain.push(cur);
		if (cur.id === untilInclusive.id) {
			break;
		}
		cur = cur.parent;
	}
	return chain;
}

function chooseXmlFormatToParse(reportTypes: ReportType[]): 'junit' | 'phpunit' | undefined {
	const hasPhpunit = reportTypes.includes('phpunit');
	const hasJunit = reportTypes.includes('junit');
	if (hasPhpunit) {
		return 'phpunit';
	}
	if (hasJunit) {
		return 'junit';
	}
	return undefined;
}

function populateTestsFromFile(
	controller: vscode.TestController,
	parent: vscode.TestItem,
	filePath: string
) {
	const content = fs.readFileSync(filePath, 'utf8');
	const lines = content.split(/\r?\n/);

	const isCest = filePath.endsWith('Cest.php');

	const testRegex = /function\s+(test\w+)\s*\(/;
	const cestRegex = /public\s+function\s+([A-Za-z_]\w*)\s*\(/;

	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];

		const match = isCest ? cestRegex.exec(text) : testRegex.exec(text);
		if (!match) {
			continue;
		}

		const methodName = match[1];

		if (isCest && methodName.startsWith('_')) {
			continue;
		}

		const id = `${parent.id}::${methodName}`;
		const range = new vscode.Range(
			new vscode.Position(line, 0),
			new vscode.Position(line, text.length)
		);

		const child = controller.createTestItem(
			id,
			methodName,
			vscode.Uri.file(filePath)
		);
		child.range = range;

		parent.children.add(child);
	}
}


function discoverCodeceptionTests(
	controller: vscode.TestController,
	workspaceFolder: vscode.WorkspaceFolder
) {
	const workspaceRoot = workspaceFolder.uri.fsPath;
	const workspaceId = workspaceRoot
		.replace(/^[A-Za-z]:\\/, '')
		.replace(/[\\/]/g, '_')
		.replace(/[^A-Za-z0-9_.-]/g, '_');
	const testsRoot = path.join(workspaceRoot, 'tests');

	if (!fs.existsSync(testsRoot)) {
		return;
	}

	const projectItem = controller.createTestItem(
		`project-${workspaceId}`,
		workspaceFolder.name,
		workspaceFolder.uri
	);

	controller.items.add(projectItem);

	const suiteFiles = fs.readdirSync(testsRoot)
		.filter(f => f.endsWith('.suite.yml'));

	for (const suiteFile of suiteFiles) {
		const suiteName = suiteFile.replace('.suite.yml', '');
		const suiteDir = path.join(testsRoot, suiteName);

		const suiteItem = controller.createTestItem(
			`suite-${workspaceId}-${suiteName}`,
			suiteName,
			vscode.Uri.file(suiteDir)
		);

		projectItem.children.add(suiteItem);

		if (!fs.existsSync(suiteDir)) {
			continue;
		}

		const testFiles = fs.readdirSync(suiteDir)
			.filter(f => f.endsWith('Test.php') || f.endsWith('Cest.php'));

		for (const file of testFiles) {
			const filePath = path.join(suiteDir, file);

			const testItem = controller.createTestItem(
				`test-${workspaceId}-${suiteName}-${file}`,
				file,
				vscode.Uri.file(filePath)
			);

			suiteItem.children.add(testItem);

			populateTestsFromFile(controller, testItem, filePath);
		}
	}
}

function refreshAllTests(controller: vscode.TestController) {
	controller.items.forEach(item => controller.items.delete(item.id));

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		return;
	}

	for (const folder of workspaceFolders) {
		discoverCodeceptionTests(controller, folder);
	}
}

export function activate(context: vscode.ExtensionContext) {
	const controller = vscode.tests.createTestController(
		'codeception',
		'Codeception'
	);

	context.subscriptions.push(controller);

	controller.resolveHandler = async () => {
		refreshAllTests(controller);
	};

	refreshAllTests(controller);

	let refreshTimer: NodeJS.Timeout | undefined;
	const scheduleRefresh = () => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
		}
		refreshTimer = setTimeout(() => {
			refreshAllTests(controller);
		}, 1000);
	};

	const suiteWatcher = vscode.workspace.createFileSystemWatcher('**/tests/*.suite.yml');
	const testWatcher = vscode.workspace.createFileSystemWatcher('**/tests/**/*Test.php');
	const cestWatcher = vscode.workspace.createFileSystemWatcher('**/tests/**/*Cest.php');

	for (const watcher of [suiteWatcher, testWatcher, cestWatcher]) {
		context.subscriptions.push(watcher);
		watcher.onDidCreate(scheduleRefresh);
		watcher.onDidChange(scheduleRefresh);
		watcher.onDidDelete(scheduleRefresh);
	}

	controller.createRunProfile(
		'Run',
		vscode.TestRunProfileKind.Run,
		async (request, token) => {
			const run = controller.createTestRun(request);
			const queue: vscode.TestItem[] = [];

			if (request.include) {
				queue.push(...request.include);
			} else {
				controller.items.forEach(item => queue.push(item));
			}

			for (const item of queue) {
				if (token.isCancellationRequested) {
					break;
				}

				try {
					await runCodeceptionTest(item, run, controller, token);
				} catch (err) {
					run.failed(item, new vscode.TestMessage(String(err)));
				}
			}

			run.end();
		}
	);

	controller.createRunProfile(
		'Debug',
		vscode.TestRunProfileKind.Debug,
		async (request, token) => {
			const run = controller.createTestRun(request);
			const queue: vscode.TestItem[] = [];

			if (request.include) {
				queue.push(...request.include);
			} else {
				controller.items.forEach(item => queue.push(item));
			}

			for (const item of queue) {
				if (token.isCancellationRequested) {
					break;
				}

				try {
					await runCodeceptionTest(item, run, controller, token);
				} catch (err) {
					run.failed(item, new vscode.TestMessage(String(err)));
				}
			}

			run.end();
		}
	);

	controller.createRunProfile(
		'Coverage',
		vscode.TestRunProfileKind.Coverage,
		async (request, token) => {
			const run = controller.createTestRun(request);
			const queue: vscode.TestItem[] = [];

			if (request.include) {
				queue.push(...request.include);
			} else {
				controller.items.forEach(item => queue.push(item));
			}

			for (const item of queue) {
				if (token.isCancellationRequested) {
					break;
				}

				try {
					await runCodeceptionTest(item, run, controller, token);
				} catch (err) {
					run.failed(item, new vscode.TestMessage(String(err)));
				}
			}

			run.end();
		}
	);
}

export async function runCodeceptionTest(
	item: vscode.TestItem,
	run: vscode.TestRun,
	controller: vscode.TestController,
	token: vscode.CancellationToken
): Promise<void> {

	const uri = getAnyUri(item);
	if (!uri) {
		return;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) { return; }

	const workspaceRoot = workspaceFolder.uri.fsPath;
	const config = vscode.workspace.getConfiguration('codeceptionTestAdapter', uri);
	const configuredCodeceptPath = (config.get<string>('codeceptPath') || '').trim();
	const reportPathInspect = config.inspect<string>('reportPath');
	const configuredReportPath = (
		reportPathInspect?.workspaceFolderValue ??
		reportPathInspect?.workspaceValue ??
		reportPathInspect?.globalValue ??
		''
	).trim();
	const configuredReportFormats = normalizeReportTypes(config.get<unknown>('reportFormats'));

	const command = findCodeceptCommand(workspaceRoot, configuredCodeceptPath);
	const runStartedAt = Date.now();

	const startedIds = new Set<string>();
	const startedChain = getSelfAndAncestors(item);
	for (const ti of startedChain) {
		if (!startedIds.has(ti.id)) {
			run.started(ti);
			startedIds.add(ti.id);
		}
	}
	const startedSubtree = getSelfAndDescendants(item);
	for (const ti of startedSubtree) {
		if (!startedIds.has(ti.id)) {
			run.started(ti);
			startedIds.add(ti.id);
		}
	}
	const finalizeChain = (outcome: 'passed' | 'failed' | 'skipped', message?: string) => {
		for (const ti of startedChain) {
			if (outcome === 'failed') {
				run.failed(ti, new vscode.TestMessage(message || 'Test failed'));
			} else if (outcome === 'passed') {
				run.passed(ti);
			} else {
				run.skipped(ti);
			}
		}
	};

	const filePath = uri.fsPath;
	const testsRoot = path.join(workspaceRoot, 'tests');
	const outputDir = getCodeceptionOutputDir(workspaceRoot);

	const reportTypesToGenerate: ReportType[] = configuredReportFormats.length > 0
		? configuredReportFormats
		: ['junit'];

	// Determine which XML format we will parse.
	const xmlFormatToParse = chooseXmlFormatToParse(reportTypesToGenerate);
	if (!xmlFormatToParse) {
		vscode.window.showWarningMessage(
			'Codeception Test Adapter: no XML report type selected. Enable reportFormats (junit/phpunit) to see test results.'
		);
	}

	const explicitReportPath = configuredReportPath
		? resolveWorkspacePath(workspaceRoot, configuredReportPath)
		: '';
	const defaultXmlReportPath = xmlFormatToParse
		? path.join(outputDir, getDefaultReportFileName(xmlFormatToParse))
		: '';
	const reportPath = explicitReportPath || defaultXmlReportPath;

	// cleanup previous report file if we are going to parse XML
	if (reportPath && fs.existsSync(reportPath)) {
		try {
			fs.unlinkSync(reportPath);
		} catch {
			// ignore
		}
	}

	let args: string[];

	const reportArgs: string[] = [];

	for (const rt of reportTypesToGenerate) {
		if (rt === 'html') {
			reportArgs.push('--html');
		} else if (rt === 'phpunit') {
			reportArgs.push('--phpunit-xml');
		} else {
			reportArgs.push('--xml');
		}
	}

	if (item.id.startsWith('project-')) {
		args = ['run', '--no-interaction', ...reportArgs];
	} else if (filePath.endsWith('.php')) {
		const relative = path.relative(testsRoot, filePath);
		const parts = relative.split(path.sep);
		const suite = parts[0];
		let file = parts.slice(1).join(path.sep);
		const fileBaseName = path.basename(filePath, '.php');
		let filter: string | undefined;

		// if a specific method was selected, narrow run to that method only
		// using Codeception --filter syntax: FileName:methodName
		if (
			item.parent &&
			item.parent.uri?.fsPath === filePath &&
			item.parent.parent?.uri?.fsPath !== filePath
		) {
			const methodName = item.label;
			if (methodName) {
				filter = `${fileBaseName}:${methodName}`;
			}
		} else if (
			item.parent &&
			item.parent.parent &&
			item.parent.parent.uri?.fsPath === filePath
		) {
			// dataset node: item -> method -> file
			const methodName = item.parent.label;
			if (methodName) {
				const match = item.id.match(/::data::(\d+)$/);
				const datasetIndex = match ? Number(match[1]) : undefined;
				filter = `${fileBaseName}:${methodName}` +
					(Number.isFinite(datasetIndex) ? `#${datasetIndex}` : '');
			}
		}

		args = ['run', suite, file, '--no-interaction', ...reportArgs];
		if (filter) {
			args.push(`--filter=${filter}`);
		}
	} else {
		// Run an entire suite directory
		const suite = path.basename(filePath);
		args = ['run', suite, '--no-interaction', ...reportArgs];
	}

	const exitCode = await execProcess(command, args, workspaceRoot, run, token);
	if (token.isCancellationRequested || exitCode === 130) {
		run.appendOutput(normalizeOutput('Test run cancelled\n'));
		finalizeChain('skipped');
		return;
	}
	if (exitCode !== 0) {
		run.appendOutput(normalizeOutput(`Codeception exited with code ${exitCode}\n`));
	}

	if (!xmlFormatToParse) {
		// No XML report selected => no parsing is possible.
		if (exitCode !== 0) {
			finalizeChain('failed', `Codeception exited with code ${exitCode}`);
		} else {
			finalizeChain('passed');
		}
		return;
	}

	let effectiveReportPath = reportPath;
	if (!effectiveReportPath) {
		effectiveReportPath = path.join(outputDir, getDefaultReportFileName(xmlFormatToParse));
	}
	if (!fs.existsSync(effectiveReportPath)) {
		const altReportPath = path.join(outputDir, getDefaultReportFileName(xmlFormatToParse));
		if (altReportPath !== effectiveReportPath && fs.existsSync(altReportPath)) {
			effectiveReportPath = altReportPath;
		} else {
			run.appendOutput(
				normalizeOutput(`Codeception XML report not found: ${effectiveReportPath}\n`)
			);
			if (exitCode !== 0) {
				finalizeChain('failed', `Codeception exited with code ${exitCode}`);
			}
			return;
		}
		if (exitCode !== 0) {
			finalizeChain('failed', `Codeception exited with code ${exitCode}`);
		}
	}

	try {
		const stat = fs.statSync(effectiveReportPath);
		if (stat.mtimeMs < runStartedAt) {
			run.appendOutput(normalizeOutput('Codeception XML report is stale\n'));
			if (exitCode !== 0) {
				finalizeChain('failed', `Codeception exited with code ${exitCode}`);
			}
			return;
		}
	} catch {
		if (exitCode !== 0) {
			finalizeChain('failed', `Codeception exited with code ${exitCode}`);
		}
		return;
	}

	const xmlContent = fs.readFileSync(effectiveReportPath, 'utf-8');
	const parser = new XMLParser({ ignoreAttributes: false });
	const parsed = parser.parse(xmlContent);

	// get all testcases (JUnit: testcases directly under top-level suite;
	// PHPUnit XML: nested suites per class/file)
	let testcases: any[] = [];
	collectTestcasesFromNode(parsed.testsuites, testcases);
	if (testcases.length === 0) {
		collectTestcasesFromNode(parsed, testcases);
	}
	if (testcases.length === 0) {
		if (exitCode !== 0) {
			finalizeChain('failed', `Codeception exited with code ${exitCode}`);
		}
		return;
	}

	// process each testcase
	let hadFailure = false;
	const subtreeOutcomeById = new Map<
		string,
		{
			item: vscode.TestItem;
			hadFailure: boolean;
			hadPass: boolean;
			hadSkip: boolean;
		}
	>();
	const recordOutcome = (ti: vscode.TestItem, outcome: 'failed' | 'passed' | 'skipped') => {
		const agg = subtreeOutcomeById.get(ti.id) || {
			item: ti,
			hadFailure: false,
			hadPass: false,
			hadSkip: false
		};
		if (outcome === 'failed') {
			agg.hadFailure = true;
		} else if (outcome === 'passed') {
			agg.hadPass = true;
		} else {
			agg.hadSkip = true;
		}
		subtreeOutcomeById.set(ti.id, agg);
	};
	const recordOutcomeToRoot = (leaf: vscode.TestItem, outcome: 'failed' | 'passed' | 'skipped') => {
		for (const ti of getSelfAndAncestorsUntil(leaf, item)) {
			recordOutcome(ti, outcome);
		}
	};
	const getOrCreateDatasetItem = (
		methodItem: vscode.TestItem,
		datasetText: string
	): vscode.TestItem => {
		for (const [, child] of methodItem.children) {
			if (!child.id.includes('::data::')) {
				continue;
			}
			if (child.label.endsWith(` ${datasetText}`)) {
				return child;
			}
		}

		let maxIndex = -1;
		for (const [, child] of methodItem.children) {
			const m = child.id.match(/::data::(\d+)$/);
			if (!m) {
				continue;
			}
			maxIndex = Math.max(maxIndex, Number(m[1]));
		}
		const nextIndex = maxIndex + 1;
		const datasetLabel = `[${nextIndex}] ${datasetText}`;
		const datasetId = `${methodItem.id}::data::${nextIndex}`;
		const datasetItem = controller.createTestItem(
			datasetId,
			datasetLabel,
			methodItem.uri
		);
		methodItem.children.add(datasetItem);
		return datasetItem;
	};
	const methodAggregates = new Map<
		string,
		{
			methodItem: vscode.TestItem;
			hadFailure: boolean;
			hadPass: boolean;
			hadSkip: boolean;
		}
	>();
	for (const tc of testcases) {
		const testName = tc['@_name'] || 'unknown';
		const fileAttr = tc['@_file'] || '';
		const featureAttr = tc['@_feature'] || '';

		let testItem: vscode.TestItem | undefined;
		let mappedMethodItem: vscode.TestItem | undefined;

		// try to map to project -> suite -> file -> method
		for (const [, projectItem] of controller.items) {
			for (const [, suiteItem] of projectItem.children) {
				for (const [, fileItem] of suiteItem.children) {
					if (!fileItem.uri) {
						continue;
					}

					// prefer exact path match when possible
					const samePath = fileAttr && fileItem.uri.fsPath === fileAttr;
					// fall back to basename match if report points to different checkout path
					const sameName =
						!samePath && fileAttr &&
						path.basename(fileItem.uri.fsPath) === path.basename(fileAttr);

					if (!samePath && !sameName) {
						continue;
					}

					// if we ran a specific method, try to find it by name
					// handle parameterized tests like "testX with data set #0" by
					// matching both full name and base method name before the suffix
					const baseNameIndex = testName.indexOf(' with data set');
					const baseName = baseNameIndex >= 0
						? testName.substring(0, baseNameIndex)
						: testName;
					for (const [, methodItem] of fileItem.children) {
						if (methodItem.label === testName || methodItem.label === baseName) {
							mappedMethodItem = methodItem;
							testItem = methodItem;
							break;
						}
					}

					if (mappedMethodItem) {
						const dataset = featureAttr
							? extractDatasetFromFeature(String(featureAttr))
							: undefined;
						if (dataset) {
							testItem = getOrCreateDatasetItem(mappedMethodItem, dataset);
						}
					}

					if (!testItem) {
						// fall back to file-level item
						testItem = fileItem;
					}

					break;
				}
				if (testItem) { break; }
			}
			if (testItem) { break; }
		}

		if (!testItem) { testItem = item; }
		if (mappedMethodItem) {
			const agg = methodAggregates.get(mappedMethodItem.id) || {
				methodItem: mappedMethodItem,
				hadFailure: false,
				hadPass: false,
				hadSkip: false
			};
			methodAggregates.set(mappedMethodItem.id, agg);
		}

		if (tc.failure || tc.error) {
			hadFailure = true;
			run.failed(testItem, new vscode.TestMessage(tc.failure || tc.error));
			recordOutcomeToRoot(testItem, 'failed');
			if (mappedMethodItem) {
				const agg = methodAggregates.get(mappedMethodItem.id);
				if (agg) {
					agg.hadFailure = true;
				}
			}
		} else if (tc.skipped) {
			run.skipped(testItem);
			recordOutcomeToRoot(testItem, 'skipped');
			if (mappedMethodItem) {
				const agg = methodAggregates.get(mappedMethodItem.id);
				if (agg) {
					agg.hadSkip = true;
				}
			}
		} else {
			run.passed(testItem);
			recordOutcomeToRoot(testItem, 'passed');
			if (mappedMethodItem) {
				const agg = methodAggregates.get(mappedMethodItem.id);
				if (agg) {
					agg.hadPass = true;
				}
			}
		}
	}

	for (const [, agg] of methodAggregates) {
		if (agg.hadFailure) {
			run.failed(agg.methodItem, new vscode.TestMessage('One or more datasets failed'));
			recordOutcomeToRoot(agg.methodItem, 'failed');
		} else if (agg.hadPass) {
			run.passed(agg.methodItem);
			recordOutcomeToRoot(agg.methodItem, 'passed');
		} else if (agg.hadSkip) {
			run.skipped(agg.methodItem);
			recordOutcomeToRoot(agg.methodItem, 'skipped');
		}
	}

	// finalize subtree nodes (suite/file/method/dataset) that were started up front
	for (const ti of startedSubtree) {
		const a = subtreeOutcomeById.get(ti.id);
		if (!a) {
			run.skipped(ti);
			continue;
		}
		if (a.hadFailure) {
			run.failed(ti, new vscode.TestMessage('One or more child tests failed'));
		} else if (a.hadPass) {
			run.passed(ti);
		} else {
			run.skipped(ti);
		}
	}

	if (exitCode !== 0 && !hadFailure) {
		finalizeChain('failed', `Codeception exited with code ${exitCode}`);
		return;
	}
	finalizeChain(
		hadFailure ? 'failed' : 'passed',
		hadFailure ? 'One or more child tests failed' : undefined
	);
}
function resolveWorkspacePath(workspaceRoot: string, p: string): string {
	const trimmed = p.trim();
	if (!trimmed) {
		return workspaceRoot;
	}
	return path.isAbsolute(trimmed)
		? trimmed
		: path.join(workspaceRoot, trimmed);
}

function findCodeceptCommand(workspaceRoot: string, configuredPath?: string): string {
	const configured = (configuredPath || '').trim();
	if (configured) {
		const resolved = resolveWorkspacePath(workspaceRoot, configured);
		return resolved;
	}

	const local = path.join(workspaceRoot, 'vendor', 'bin', 'codecept');
	if (fs.existsSync(local)) { return local; }
	return 'codecept';
}

function execProcess(
	command: string,
	args: string[],
	cwd: string,
	run: vscode.TestRun,
	token: vscode.CancellationToken
): Promise<number> {
	return new Promise(resolve => {
		if (token.isCancellationRequested) {
			resolve(130);
			return;
		}

		run.appendOutput(
			normalizeOutput(`> ${[command, ...args].join(' ')}\n`)
		);

		const proc = spawn(command, args, {
			cwd,
			shell: process.platform === 'win32',
			env: process.env,
			detached: process.platform !== 'win32'
		});

		let killedByCancel = false;
		const killProcessTree = () => {
			if (proc.killed) {
				return;
			}
			killedByCancel = true;
			try {
				if (process.platform !== 'win32' && proc.pid) {
					process.kill(-proc.pid, 'SIGTERM');
				} else {
					proc.kill('SIGTERM');
				}
			} catch {
				// ignore
			}

			setTimeout(() => {
				try {
					if (process.platform !== 'win32' && proc.pid) {
						process.kill(-proc.pid, 'SIGKILL');
					} else {
						proc.kill('SIGKILL');
					}
				} catch {
					// ignore
				}
			}, 2000);
		};

		const cancelSubscription = token.onCancellationRequested(() => {
			run.appendOutput(normalizeOutput('Cancellation requested\n'));
			killProcessTree();
		});

		proc.stdout.on('data', data => run.appendOutput(normalizeOutput(data.toString())));
		proc.stderr.on('data', data => run.appendOutput(normalizeOutput(data.toString())));

		proc.on('error', () => {
			cancelSubscription.dispose();
			resolve(1);
		});

		proc.on('close', code => {
			cancelSubscription.dispose();
			if (killedByCancel) {
				resolve(130);
				return;
			}
			resolve(code ?? 0);
		});
	});
}

function normalizeOutput(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/\n/g, '\r\n');
}

export function deactivate() { }
