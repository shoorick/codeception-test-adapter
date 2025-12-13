import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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

	// Run handler
	controller.createRunProfile(
		'Run',
		vscode.TestRunProfileKind.Run,
		(request, token) => {
			const run = controller.createTestRun(request);

			const queue: vscode.TestItem[] = [];
			if (request.include) {
				queue.push(...request.include);
			} else {
				controller.items.forEach(item => queue.push(item));
			}

			for (const item of queue) {
				run.started(item);

				// imitate execution
				setTimeout(() => {
					run.passed(item);
				}, 300);
			}

			setTimeout(() => run.end(), 400);
		}
	);

	console.log('Codeception Test Adapter activated (dummy test)');
}

export function deactivate() { }
