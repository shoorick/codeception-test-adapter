import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { XMLParser } from 'fast-xml-parser';


function discoverCodeceptionTests(
	controller: vscode.TestController,
	workspaceRoot: string
) {
	const testsRoot = path.join(workspaceRoot, 'tests');

	if (!fs.existsSync(testsRoot)) {
		return;
	}

	const suiteFiles = fs.readdirSync(testsRoot)
		.filter(f => f.endsWith('.suite.yml'));

	for (const suiteFile of suiteFiles) {
		const suiteName = suiteFile.replace('.suite.yml', '');
		const suiteDir = path.join(testsRoot, suiteName);

		const suiteItem = controller.createTestItem(
			`suite-${suiteName}`,
			suiteName,
			vscode.Uri.file(suiteDir)
		);

		controller.items.add(suiteItem);

		if (!fs.existsSync(suiteDir)) {
			continue;
		}

		const testFiles = fs.readdirSync(suiteDir)
			.filter(f => f.endsWith('Test.php') || f.endsWith('Cest.php'));

		for (const file of testFiles) {
			const filePath = path.join(suiteDir, file);

			const testItem = controller.createTestItem(
				`test-${suiteName}-${file}`,
				file,
				vscode.Uri.file(filePath)
			);

			suiteItem.children.add(testItem);
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const controller = vscode.tests.createTestController(
		'codeception',
		'Codeception'
	);

	context.subscriptions.push(controller);

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (workspaceFolder) {
		discoverCodeceptionTests(controller, workspaceFolder.uri.fsPath);
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

				run.started(item);

				try {
					await runCodeceptionTest(item, run, controller);
					run.passed(item);
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
	const command = findCodeceptCommand(workspaceRoot);

	const filePath = uri.fsPath;
	const testsRoot = path.join(workspaceRoot, 'tests');

	let args: string[];

	if (filePath.endsWith('.php')) {
		// Run a single test file
		const relative = path.relative(testsRoot, filePath);
		const parts = relative.split(path.sep);
		const suite = parts[0];
		const file = parts.slice(1).join(path.sep);
		args = ['run', suite, file, '--no-interaction', '--xml'];
	} else {
		// Run an entire suite
		const suite = path.basename(filePath);
		args = ['run', suite, '--no-interaction', '--xml'];
	}

	try {
		await execProcess(command, args, workspaceRoot, run);
	} catch (err: any) {
		run.appendOutput(err.message + '\n');
		run.end();
		return;
	}

	// XML report path (default)
	const reportPath = path.join(workspaceRoot, 'tests', '_output', 'report.xml');
	if (!fs.existsSync(reportPath)) {
		run.appendOutput('Codeception XML report not found\n');
		run.end();
		return;
	}

	const xmlContent = fs.readFileSync(reportPath, 'utf-8');
	const parser = new XMLParser({ ignoreAttributes: false });
	const parsed = parser.parse(xmlContent);

	// get all testcases from all testsuites
	let testcases: any[] = [];
	const suites = parsed.testsuites?.testsuite;
	if (!suites) {
		run.end();
		return;
	}

	// ensure suites is always array
	const suiteArray = Array.isArray(suites) ? suites : [suites];

	for (const suite of suiteArray) {
		const cases = suite.testcase;
		if (!cases) { continue; }

		testcases.push(...(Array.isArray(cases) ? cases : [cases]));
	}

	// process each testcase
	for (const tc of testcases) {
		const testName = tc['@_name'] || 'unknown';
		const fileAttr = tc['@_file'] || '';

		// find TestItem by uri
		let testItem: vscode.TestItem | undefined;
		for (const [, test] of controller.items) {
			if (test.uri?.fsPath === fileAttr) {
				testItem = test;
				break;
			}
		}
		if (!testItem) { testItem = item; }

		run.started(testItem);

		if (tc.failure || tc.error) {
			run.failed(testItem, new vscode.TestMessage(tc.failure || tc.error));
		} else if (tc.skipped) {
			run.skipped(testItem);
		} else {
			run.passed(testItem);
		}
	}

	run.end();
}

function findCodeceptCommand(workspaceRoot: string): string {
	const local = path.join(workspaceRoot, 'vendor', 'bin', 'codecept');
	if (fs.existsSync(local)) { return local; }
	return 'codecept';
}

function execProcess(
	command: string,
	args: string[],
	cwd: string,
	run: vscode.TestRun
): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: true, env: process.env });

		proc.stdout.on('data', data => run.appendOutput(data.toString()));
		proc.stderr.on('data', data => run.appendOutput(data.toString()));

		proc.on('exit', code => {
			if (code === 0) { resolve(); }
			else { reject(new Error(`Process exited with code ${code}`)); }
		});
	});
}

export function deactivate() { }
