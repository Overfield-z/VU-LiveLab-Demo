// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const QUESTION_VIEW_ID = 'my-first-vscode-extension.questionView';
const PYTHON_TIMEOUT_MS = 5000;
const MAX_OUTPUT_CHARS = 20000;

const TASKS = [
	{
		title: 'ต่อท้าย List ด้วย mango',
		prompt: 'สร้าง List ชื่อ fruits ที่มี "apple" และ "banana" เพิ่ม "mango" ไว้ท้าย List แล้วพิมพ์สมาชิก index 2',
		hint: 'append() เพิ่มสมาชิกไว้ท้าย List และ index เริ่มนับจาก 0',
		expectedOutput: 'mango'
	},
	{
		title: 'แทรก green ใน List',
		prompt: 'สร้าง List ชื่อ colors ที่มี "red" และ "blue" แทรก "green" ที่ index 1 แล้วพิมพ์สมาชิก index 1',
		hint: 'insert(1, "green") จะแทรก green ก่อนสมาชิกเดิมที่อยู่ index 1',
		expectedOutput: 'green'
	}
];

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "my-first-vscode-extension" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('my-first-vscode-extension.helloWorld', function () {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from my-first-vscode-extension!');
	});

	context.subscriptions.push(disposable);

	// Register the provider that fills the VU LiveLab view in the Explorer sidebar.
	const questionViewProvider = new QuestionViewProvider();
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => questionViewProvider.trackEditor(editor))
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(QUESTION_VIEW_ID, questionViewProvider)
	);
}

class QuestionViewProvider {
	constructor() {
		this.webviewView = undefined;
		this.taskIndex = 0;
		this.pythonFileUri = undefined;
		this.trackEditor(vscode.window.activeTextEditor);
	}

	trackEditor(editor) {
		if (editor?.document.languageId === 'python' && editor.document.uri.scheme === 'file') {
			this.pythonFileUri = editor.document.uri;
			this.sendActiveFile();
		}
	}

	resolveWebviewView(webviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((message) => {
			void this.handleMessage(message);
		});
	}

	async handleMessage(message) {
		if (message.type === 'ready') {
			this.sendTask();
			this.sendActiveFile();
		} else if (message.type === 'previousTask') {
			this.taskIndex = Math.max(0, this.taskIndex - 1);
			this.sendTask();
		} else if (message.type === 'nextTask') {
			this.taskIndex = Math.min(TASKS.length - 1, this.taskIndex + 1);
			this.sendTask();
		} else if (message.type === 'showHint') {
			this.postMessage({ type: 'hint', text: TASKS[this.taskIndex].hint });
		} else if (message.type === 'checkCode') {
			await this.checkCurrentCode();
		}
	}

	sendTask() {
		const task = TASKS[this.taskIndex];
		this.postMessage({
			type: 'task',
			index: this.taskIndex,
			total: TASKS.length,
			title: task.title,
			prompt: task.prompt
		});
	}

	sendActiveFile() {
		const fileName = this.pythonFileUri ? path.basename(this.pythonFileUri.fsPath) : '';
		this.postMessage({ type: 'activeFile', fileName });
	}

	postMessage(message) {
		this.webviewView?.webview.postMessage(message);
	}

	async checkCurrentCode() {
		const task = TASKS[this.taskIndex];
		this.postMessage({ type: 'checking' });

		try {
			if (!this.pythonFileUri) {
				throw new Error('กรุณาเปิดไฟล์ Python (.py) ก่อน แล้วค่อยกลับมากดตรวจโค้ด');
			}

			const document = await vscode.workspace.openTextDocument(this.pythonFileUri);
			if (!(await document.save())) {
				throw new Error('บันทึกไฟล์ไม่สำเร็จ กรุณาบันทึกไฟล์แล้วลองใหม่');
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			const result = await this.runPythonFile(
				document.uri.fsPath,
				workspaceFolder?.uri.fsPath ?? path.dirname(document.uri.fsPath)
			);
			const actualOutput = result.stdout.replace(/\r\n/g, '\n').trimEnd();
			const passed = actualOutput === task.expectedOutput;
			this.postMessage({
				type: 'result',
				passed,
				output: actualOutput,
				detail: result.stderr
			});
		} catch (error) {
			this.postMessage({
				type: 'result',
				passed: false,
				output: '',
				detail: error instanceof Error ? error.message : String(error)
			});
		}
	}

	runPythonFile(filePath, cwd) {
		const pythonCommand = vscode.workspace.getConfiguration('vuLiveLab').get('pythonCommand', 'python');

		return new Promise((resolve, reject) => {
			const child = spawn(pythonCommand, [filePath], { cwd, windowsHide: true });
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			let outputLimitReached = false;
			let settled = false;

			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, PYTHON_TIMEOUT_MS);

			const collect = (stream, readOutput, writeOutput) => {
				stream.setEncoding('utf8');
				stream.on('data', (chunk) => {
					const current = readOutput();
					const remaining = MAX_OUTPUT_CHARS - current.length;
					writeOutput(current + chunk.slice(0, Math.max(0, remaining)));
					if (chunk.length > remaining) {
						outputLimitReached = true;
						child.kill();
					}
				});
			};

			collect(child.stdout, () => stdout, (value) => { stdout = value; });
			collect(child.stderr, () => stderr, (value) => { stderr = value; });

			child.on('error', (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`เปิด Python ไม่ได้ (${pythonCommand}): ${error.message}`));
			});

			child.on('close', (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);

				if (timedOut) {
					reject(new Error('โปรแกรมใช้เวลานานเกิน 5 วินาที จึงหยุดการทำงาน'));
				} else if (outputLimitReached) {
					reject(new Error('โปรแกรมแสดงผลมากเกินไป จึงหยุดการทำงาน'));
				} else if (code !== 0) {
					reject(new Error(stderr.trim() || `Python จบการทำงานด้วยรหัส ${code}`));
				} else {
					resolve({ stdout, stderr });
				}
			});
		});
	}

	getHtml(webview) {
		const nonce = crypto.randomBytes(16).toString('base64');

		return `<!DOCTYPE html>
		<html lang="th">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
			<style>
				body {
					padding: 12px;
					color: var(--vscode-foreground);
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
				}
				.eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; }
				h2 { margin: 6px 0 12px; font-size: 18px; }
				.card {
					padding: 12px;
					border: 1px solid var(--vscode-panel-border);
					border-radius: 6px;
					background: var(--vscode-editor-background);
				}
				pre {
					padding: 10px;
					border-radius: 4px;
					background: var(--vscode-textCodeBlock-background);
					white-space: pre-wrap;
				}
				label { display: block; margin: 12px 0 6px; }
				input {
					box-sizing: border-box;
					width: 100%;
					padding: 7px;
					color: var(--vscode-input-foreground);
					background: var(--vscode-input-background);
					border: 1px solid var(--vscode-input-border, transparent);
					border-radius: 2px;
				}
				button {
					margin: 10px 6px 0 0;
					padding: 6px 10px;
					color: var(--vscode-button-foreground);
					background: var(--vscode-button-background);
					border: 0;
					border-radius: 2px;
					cursor: pointer;
				}
				button:hover { background: var(--vscode-button-hoverBackground); }
				button.secondary {
					color: var(--vscode-button-secondaryForeground);
					background: var(--vscode-button-secondaryBackground);
				}
				#result { min-height: 1.4em; margin-top: 12px; }
				#fileName { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 10px 0; }
				#result { white-space: pre-wrap; }
				.navigation { display: flex; justify-content: space-between; gap: 8px; }
				button:disabled { opacity: 0.5; cursor: default; }
			</style>
		</head>
		<body>
			<div class="eyebrow">VU LIVELAB · PYTHON LIST</div>
			<h2 id="taskTitle">กำลังโหลดโจทย์...</h2>
			<section class="card">
				<div id="progress" class="eyebrow"></div>
				<p id="prompt"></p>
				<p>เปิดไฟล์ Python (.py) ใน Editor เขียนคำตอบ แล้วกดตรวจโค้ด</p>
				<div id="fileName">ไฟล์ Python: ยังไม่ได้เลือก</div>
				<button id="check">ตรวจโค้ด</button>
				<button id="hint" class="secondary">คำใบ้</button>
				<div id="result" role="status" aria-live="polite"></div>
				<div class="navigation">
					<button id="previous" class="secondary">ข้อก่อนหน้า</button>
					<button id="next">ข้อถัดไป</button>
				</div>
			</section>
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				const result = document.getElementById('result');
				const send = (type) => vscode.postMessage({ type });
				document.getElementById('check').addEventListener('click', () => send('checkCode'));
				document.getElementById('hint').addEventListener('click', () => {
					send('showHint');
				});
				document.getElementById('previous').addEventListener('click', () => send('previousTask'));
				document.getElementById('next').addEventListener('click', () => send('nextTask'));
				window.addEventListener('message', (event) => {
					const message = event.data;
					if (message.type === 'task') {
						document.getElementById('taskTitle').textContent = message.title;
						document.getElementById('progress').textContent = 'โจทย์ ' + (message.index + 1) + ' / ' + message.total;
						document.getElementById('prompt').textContent = message.prompt;
						document.getElementById('previous').disabled = message.index === 0;
						document.getElementById('next').disabled = message.index === message.total - 1;
						result.textContent = '';
					} else if (message.type === 'activeFile') {
						document.getElementById('fileName').textContent = message.fileName
							? 'ไฟล์ Python: ' + message.fileName
							: 'ไฟล์ Python: ยังไม่ได้เปิดไฟล์ .py';
					} else if (message.type === 'checking') {
						result.textContent = 'กำลังบันทึกและรันไฟล์ Python...';
					} else if (message.type === 'result') {
						const output = message.output ? '\\nผลลัพธ์: ' + message.output : '';
						const detail = message.detail ? '\\n' + message.detail : '';
						result.textContent = (message.passed ? '✅ ผ่าน!' : '❌ ยังไม่ผ่าน') + output + detail;
					} else if (event.data.type === 'hint') {
						result.textContent = 'คำใบ้: ' + message.text;
					}
				});
				window.addEventListener('load', () => send('ready'));
			</script>
		</body>
		</html>`;
	}
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
