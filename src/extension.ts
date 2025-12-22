import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { XMLParser } from 'fast-xml-parser';

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
					await runCodeceptionTest(item, run, controller);
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
	controller: vscode.TestController
): Promise<void> {

	const uri = item.uri;
	if (!uri) { return; }

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) { return; }

	const workspaceRoot = workspaceFolder.uri.fsPath;
	const config = vscode.workspace.getConfiguration('codeceptionTestAdapter', uri);
	const configuredCodeceptPath = (config.get<string>('codeceptPath') || '').trim();
	const configuredReportPath = (config.get<string>('reportPath') || '').trim();

	const command = findCodeceptCommand(workspaceRoot, configuredCodeceptPath);
	const runStartedAt = Date.now();

	const filePath = uri.fsPath;
	const testsRoot = path.join(workspaceRoot, 'tests');
	const reportPath = resolveWorkspacePath(
		workspaceRoot,
		configuredReportPath || 'tests/_output/report.xml'
	);
	if (fs.existsSync(reportPath)) {
		try {
			fs.unlinkSync(reportPath);
		} catch {
			// ignore
		}
	}

	let args: string[];

	if (item.id.startsWith('project-')) {
		args = ['run', '--no-interaction', '--xml'];
	} else if (filePath.endsWith('.php')) {
		const relative = path.relative(testsRoot, filePath);
		const parts = relative.split(path.sep);
		const suite = parts[0];
		let file = parts.slice(1).join(path.sep);

		// if a specific method was selected, narrow run to that method only
		// using Codeception syntax: path/to/file.php:methodName
		if (item.parent && item.parent.uri?.fsPath === filePath) {
			const methodName = item.label;
			if (methodName) {
				file = `${file}:${methodName}`;
			}
		}

		args = ['run', suite, file, '--no-interaction', '--xml'];
	} else {
		// Run an entire suite directory
		const suite = path.basename(filePath);
		args = ['run', suite, '--no-interaction', '--xml'];
	}

	const exitCode = await execProcess(command, args, workspaceRoot, run);
	if (exitCode !== 0) {
		run.appendOutput(normalizeOutput(`Codeception exited with code ${exitCode}\n`));
	}

	if (!fs.existsSync(reportPath)) {
		run.appendOutput(normalizeOutput('Codeception XML report not found\n'));
		if (exitCode !== 0) {
			run.failed(item, new vscode.TestMessage(`Codeception exited with code ${exitCode}`));
		}
		return;
	}

	try {
		const stat = fs.statSync(reportPath);
		if (stat.mtimeMs < runStartedAt) {
			run.appendOutput(normalizeOutput('Codeception XML report is stale\n'));
			if (exitCode !== 0) {
				run.failed(item, new vscode.TestMessage(`Codeception exited with code ${exitCode}`));
			}
			return;
		}
	} catch {
		if (exitCode !== 0) {
			run.failed(item, new vscode.TestMessage(`Codeception exited with code ${exitCode}`));
		}
		return;
	}

	const xmlContent = fs.readFileSync(reportPath, 'utf-8');
	const parser = new XMLParser({ ignoreAttributes: false });
	const parsed = parser.parse(xmlContent);

	// get all testcases from all testsuites
	let testcases: any[] = [];
	const suites = parsed.testsuites?.testsuite;
	if (!suites) {
		if (exitCode !== 0) {
			run.failed(item, new vscode.TestMessage(`Codeception exited with code ${exitCode}`));
		}
		return;
	}

	// ensure suites is always array
	const suiteArray = Array.isArray(suites) ? suites : [suites];

	for (const suite of suiteArray) {
		const cases = suite.testcase;
		if (!cases) { continue; }

		testcases.push(...(Array.isArray(cases) ? cases : [cases]));
	}

	if (testcases.length === 0) {
		if (exitCode !== 0) {
			run.failed(item, new vscode.TestMessage(`Codeception exited with code ${exitCode}`));
		} else {
			run.passed(item);
		}
		return;
	}

	// process each testcase
	let hadFailure = false;
	for (const tc of testcases) {
		const testName = tc['@_name'] || 'unknown';
		const fileAttr = tc['@_file'] || '';

		let testItem: vscode.TestItem | undefined;

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
							testItem = methodItem;
							break;
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

		run.started(testItem);

		if (tc.failure || tc.error) {
			hadFailure = true;
			run.failed(testItem, new vscode.TestMessage(tc.failure || tc.error));
		} else if (tc.skipped) {
			run.skipped(testItem);
		} else {
			run.passed(testItem);
		}
	}

	if (exitCode !== 0 && !hadFailure) {
		run.failed(item, new vscode.TestMessage(`Codeception exited with code ${exitCode}`));
	}
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
	run: vscode.TestRun
): Promise<number> {
	return new Promise(resolve => {
		const proc = spawn(command, args, { cwd, shell: true, env: process.env });

		proc.stdout.on('data', data => run.appendOutput(normalizeOutput(data.toString())));
		proc.stderr.on('data', data => run.appendOutput(normalizeOutput(data.toString())));

		proc.on('exit', code => {
			resolve(typeof code === 'number' ? code : 0);
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
