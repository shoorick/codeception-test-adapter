// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const controller = vscode.tests.createTestController(
		'codeception',
		'Codeception'
	);

	context.subscriptions.push(controller);

	// Dummy suite
	const suite = controller.createTestItem(
		'dummy-suite',
		'Dummy suite',
		vscode.Uri.parse('file:///dummy')
	);
	controller.items.add(suite);

	// Dummy test
	const test = controller.createTestItem(
		'dummy-test',
		'it works',
		vscode.Uri.parse('file:///dummy')
	);
	suite.children.add(test);

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
