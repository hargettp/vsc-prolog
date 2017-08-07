("use strict");
import { spawn } from "process-promises";
import {
  CancellationToken,
  DocumentFormattingEditProvider,
  DocumentRangeFormattingEditProvider,
  FormattingOptions,
  OnTypeFormattingEditProvider,
  OutputChannel,
  Range,
  TextDocument,
  TextEdit,
  window,
  workspace,
  WorkspaceConfiguration,
  Position,
  extensions
} from "vscode";
// import { ScopeInfoAPI, Token } from "scope-info";
import * as jsesc from "jsesc";

interface IComment {
  location: number; // character location in the range
  comment: string;
}

interface ITermInfo {
  charsSofar: number;
  startLine: number;
  startChar: number;
  isValid: boolean;
  termStr: string;
  comments: IComment[];
  endLine?: number;
  endChar?: number;
}

export default class PrologDocumentFormatter
  implements DocumentRangeFormattingEditProvider,
    DocumentFormattingEditProvider,
    OnTypeFormattingEditProvider {
  private _section: WorkspaceConfiguration;
  private _tabSize: number;
  private _insertSpaces: boolean;
  private _tabDistance: number;
  private _executable: string;
  private _args: string[];
  private _outputChannel: OutputChannel;
  private _textEdits: TextEdit[] = [];
  private _currentTermInfo: ITermInfo = null;
  // private _si: ScopeInfoAPI;
  private _startChars: number;

  constructor() {
    this._section = workspace.getConfiguration("prolog");
    this._tabSize = this._section.get("format.tabSize", 4);
    this._insertSpaces = this._section.get("format.insertSpaces", true);
    this._tabDistance = this._insertSpaces ? 0 : this._tabSize;
    this._executable = this._section.get("executablePath", "swipl");
    this._args = ["--nodebug", "-q"];
    this._outputChannel = window.createOutputChannel("PrologFormatter");
  }

  private getClauseHeadStart(doc: TextDocument, line: number): Position {
    const headReg = /^\s*[\s\S]+?(?=:-|-->)/;
    const lineTxt = doc.lineAt(line).text;
    let match = lineTxt.match(headReg);
    if (match) {
      let firstNonSpcIndex = lineTxt.match(/[^\s]/).index;
      return new Position(line, firstNonSpcIndex);
    }
    line--;
    if (line < 0) {
      line = 0;
      return new Position(0, 0);
    }
    return this.getClauseHeadStart(doc, line);
  }

  private getClauseEnd(doc: TextDocument, line: number): Position {
    let lineTxt = doc.lineAt(line).text;
    let dotIndex = lineTxt.indexOf(".");
    while (dotIndex > -1) {
      if (this.isClauseEndDot(doc, new Position(line, dotIndex))) {
        return new Position(line, dotIndex + 1);
      }
      dotIndex = lineTxt.indexOf(".", dotIndex + 1);
    }
    line++;
    if (line === doc.lineCount) {
      line--;
      return new Position(line, lineTxt.length);
    }
    return this.getClauseEnd(doc, line);
  }

  private isClauseEndDot(doc: TextDocument, pos: Position): boolean {
    const txt = doc.getText();
    const offset = doc.offsetAt(pos);
    const subtxt = txt
      .slice(0, offset + 1)
      .replace(/\\'/g, "")
      .replace(/\\"/, "")
      .replace(/"[^\\"]*"/g, "")
      .replace(/\'[^\']*\'/g, "");
    const open = subtxt.lastIndexOf("/*");
    const close = subtxt.lastIndexOf("*/");
    return (
      txt.charAt(offset - 1) !== "." &&
      txt.charAt(offset + 1) !== "." &&
      subtxt.indexOf("'") === -1 &&
      subtxt.indexOf('"') === -1 &&
      !/%[^\n]*$/.test(subtxt) &&
      (open === -1 || open < close)
    );
  }

  private validRange(doc: TextDocument, initRange: Range): Range {
    const docTxt = doc.getText();
    let end = docTxt.indexOf(".", doc.offsetAt(initRange.end) - 1);
    while (end > -1) {
      if (this.isClauseEndDot(doc, doc.positionAt(end))) {
        break;
      }
      end = docTxt.indexOf(".", end + 1);
    }
    if (end === -1) {
      end = docTxt.length - 1;
    }
    let endPos = doc.positionAt(end + 1);

    let start = docTxt.slice(0, doc.offsetAt(initRange.start)).lastIndexOf(".");
    while (start > -1) {
      if (this.isClauseEndDot(doc, doc.positionAt(start))) {
        break;
      }
      start = docTxt.slice(0, start - 1).lastIndexOf(".");
    }

    if (start === -1) {
      start = 0;
    }

    if (start > 0) {
      let nonTermStart = 0;
      let re: RegExp = /^\s+|^%.*\n|^\/\*.*?\*\//;
      let txt = docTxt.slice(start + 1);
      let match = txt.match(re);
      while (match) {
        nonTermStart += match[0].length;
        match = txt.slice(nonTermStart).match(re);
      }
      start += nonTermStart;
    }
    let startPos = doc.positionAt(start === 0 ? 0 : start + 1);

    return startPos && endPos ? new Range(startPos, endPos) : null;
  }
  public provideDocumentRangeFormattingEdits(
    doc: TextDocument,
    range: Range,
    options: FormattingOptions,
    token: CancellationToken
  ): TextEdit[] | Thenable<TextEdit[]> {
    return this.getTextEdits(doc, this.validRange(doc, range));
  }

  public provideDocumentFormattingEdits(
    doc: TextDocument
  ): TextEdit[] | Thenable<TextEdit[]> {
    return this.getTextEdits(
      doc,
      new Range(
        0,
        0,
        doc.lineCount - 1,
        doc.lineAt(doc.lineCount - 1).text.length
      )
    );
  }

  public provideOnTypeFormattingEdits(
    doc: TextDocument,
    position: Position,
    ch: string,
    options: FormattingOptions,
    token: CancellationToken
  ): TextEdit[] | Thenable<TextEdit[]> {
    if (
      ch === "." &&
      this.isClauseEndDot(
        doc,
        new Position(position.line, position.character - 1)
      )
    ) {
      let range = new Range(
        position.line,
        0,
        position.line,
        position.character - 1
      );
      return this.getTextEdits(doc, this.validRange(doc, range));
    } else {
      return [];
    }
  }

  private outputMsg(msg: string) {
    this._outputChannel.append(msg);
    this._outputChannel.show();
  }

  private async getTextEdits(doc: TextDocument, range: Range) {
    await this.getFormattedCode(doc, range);
    return this._textEdits;
  }

  private async getFormattedCode(doc: TextDocument, range: Range) {
    this._textEdits = [];
    this._currentTermInfo = null;
    if (!doc.validateRange(range)) {
      return [];
    }
    let docText = jsesc(doc.getText(), { quotes: "double" });
    let rangeTxt = jsesc(doc.getText(range), { quotes: "double" });
    let goals = `
      use_module('${__dirname}/formatter.pl').
      open_string("${docText}", S),
      load_files(doctxt, [stream(S)]).
      setup_call_cleanup(
        (new_memory_file(MemFH), open_memory_file(MemFH, write, MemWStream)),
        (split_string("${rangeTxt}", '\n', '', TxtLst),
         forall(member(Line, TxtLst), writeln(MemWStream, Line)),
         close(MemWStream),
         open_memory_file(MemFH, read, MemRStream),
         formatter:read_and_portray_term(${this._tabSize}, ${this
      ._tabDistance}, MemRStream)),
        (close(MemRStream), free_memory_file(MemFH))
      ).\n
    `;
    let termStr = "";
    let prologProc = null;

    try {
      let prologChild = await spawn(this._executable, this._args, {})
        .on("process", proc => {
          if (proc.pid) {
            prologProc = proc;
            proc.stdin.write(goals);
            proc.stdin.end();
          }
        })
        .on("stdout", data => {
          if (/::::::ALLOVER/.test(data)) {
            this.resolve_terms(doc, termStr, range, true);
          }
          if (/TERMSEGMENTBEGIN:::/.test(data)) {
            this.resolve_terms(doc, termStr, range);
            termStr = data + "\n";
          } else {
            termStr += data + "\n";
          }
        })
        .on("stderr", err => {
          console.log("err:" + err);
        })
        .on("close", _ => {
          console.log("closed");
        });
      console.log("exit code:" + prologChild.exitCode);
    } catch (error) {
      let message: string = null;
      if ((<any>error).code === "ENOENT") {
        message = `Cannot debug the prolog file. The Prolog executable was not found. Correct the 'prolog.executablePath' configure please.`;
      } else {
        message = error.message
          ? error.message
          : `Failed to run swipl using path: ${this
              ._executable}. Reason is unknown.`;
      }
    }
  }

  private resolve_terms(
    doc: TextDocument,
    text: string,
    range: Range,
    last: boolean = false
  ) {
    if (!/TERMSEGMENTBEGIN:::/.test(text)) {
      return;
    }
    let termPosRe = /TERMPOSBEGIN:::(\d+):::TERMPOSEND/;
    let varsRe = /VARIABLESBEGIN:::\[([\s\S]*?)\]:::VARIABLESEND/;
    let termRe = /TERMBEGIN:::([\s\S]+?):::TERMEND/;
    let commsRe = /COMMENTSBIGIN:::([\s\S]*?):::COMMENTSEND/;
    let termPos = text.match(termPosRe),
      term = text.match(termRe),
      vars = text.match(varsRe),
      comms = text.match(commsRe);
    let commsObj: { comments: IComment[] } = JSON.parse(comms[1]);
    let commsArr = commsObj.comments;

    let formattedTerm = this.restoreVariableNames(term[1], vars[1].split(","));
    let termCharA = parseInt(termPos[1]);
    if (commsArr.length > 0) {
      termCharA =
        termCharA < commsArr[0].location ? termCharA : commsArr[0].location;
      commsArr.forEach((comm: IComment) => {
        comm.location -= termCharA;
      });
    }

    if (!this._currentTermInfo) {
      (this._startChars = doc.getText(
        new Range(new Position(0, 0), range.start)
      ).length), (this._currentTermInfo = {
        charsSofar: 0,
        startLine: range.start.line,
        startChar: range.start.character,
        isValid: vars[1] === "givingup" ? false : true,
        termStr: formattedTerm,
        comments: commsArr
      });
    } else {
      let endPos = doc.positionAt(termCharA + this._startChars);
      this._currentTermInfo.endLine = endPos.line;
      this._currentTermInfo.endChar = endPos.character;
      if (this._currentTermInfo.isValid) {
        // preserve original gaps between terms
        let lastAfterTerm = doc
          .getText()
          .slice(this._currentTermInfo.charsSofar, termCharA)
          .match(/\s*$/)[0];
        this._currentTermInfo.termStr = this._currentTermInfo.termStr.replace(
          /\s*$/, // replace new line produced by portray_clause with original gaps
          lastAfterTerm
        );
        this.generateTextEdit(doc);
      }

      this._currentTermInfo.charsSofar = termCharA;
      this._currentTermInfo.startLine = this._currentTermInfo.endLine;
      this._currentTermInfo.startChar = this._currentTermInfo.endChar;
      this._currentTermInfo.termStr = formattedTerm;
      this._currentTermInfo.isValid = vars[1] === "givingup" ? false : true;
      this._currentTermInfo.comments = commsArr;
      if (last) {
        this._currentTermInfo.endLine = range.end.line;
        this._currentTermInfo.endChar = range.end.character;
        if (this._currentTermInfo.comments.length > 0) {
          this._currentTermInfo.termStr = "";
          this.generateTextEdit(doc);
        }
      }
    }
  }

  private generateTextEdit(doc: TextDocument) {
    let termRange = new Range(
      this._currentTermInfo.startLine,
      this._currentTermInfo.startChar,
      this._currentTermInfo.endLine,
      this._currentTermInfo.endChar
    );
    if (this._currentTermInfo.comments.length > 0) {
      let newComms = this.mergeComments(
        doc,
        termRange,
        this._currentTermInfo.comments
      );
      this._currentTermInfo.termStr = this.getTextWithComments(
        doc,
        termRange,
        this._currentTermInfo.termStr,
        newComms
      );
    }
    this._textEdits.push(
      new TextEdit(termRange, this._currentTermInfo.termStr)
    );
  }

  // merge adjcent comments between which there are only spaces, including new lines
  private mergeComments(
    doc: TextDocument,
    range: Range,
    comms: IComment[]
  ): IComment[] {
    let origTxt = doc.getText(range);
    let newComms: IComment[] = [];
    newComms.push(comms[0]);
    let i = 1;
    while (i < comms.length) {
      let loc = comms[i].location;
      let last = newComms.length - 1;
      let lastLoc = newComms[last].location;
      let lastComm = newComms[last].comment;
      let lastEnd = lastLoc + lastComm.length;
      let middleTxt = origTxt.slice(lastEnd, comms[i].location);
      if (middleTxt.replace(/\s|\n|\t/g, "").length === 0) {
        newComms[last].comment += middleTxt + comms[i].comment;
      } else {
        newComms.push(comms[i]);
      }
      i++;
    }
    return newComms;
  }
  private getTextWithComments(
    doc: TextDocument,
    range: Range,
    formatedText: string,
    comms: IComment[]
  ): string {
    let origTxt = doc.getText(range);

    let chars = origTxt.length;
    let txtWithComm = "";
    let lastOrigPos = 0;
    for (let i = 0; i < comms.length; i++) {
      let index = comms[i].location;
      let comment = comms[i].comment;
      let origSeg = origTxt.slice(lastOrigPos, index);

      let noSpaceOrig = origSeg.replace(/\s|\n|\t|\(|\)/g, "");
      lastOrigPos = index + comment.length;
      let j = 0,
        noSpaceFormatted: string = "";
      while (j < chars) {
        if (noSpaceFormatted === noSpaceOrig) {
          if (origTxt.charAt(index + comment.length) === "\n") {
            comment += "\n";
            lastOrigPos++;
          }
          let tail = origSeg.match(/[()]*$/)[0].length;
          let spaces = origSeg.match(/\s*$/)[0];
          if (spaces.length > 0) {
            comment = spaces + comment;
          }
          txtWithComm += formatedText.slice(0, j + tail) + comment;
          formatedText = formatedText.slice(j + tail).replace(/^\n/, "");
          break;
        }

        let char = formatedText.charAt(j);
        if (
          char !== " " &&
          char !== "\n" &&
          char !== "\t" &&
          char !== "(" &&
          char !== ")"
        ) {
          noSpaceFormatted += char;
        }
        j++;
      }
    }
    return txtWithComm + formatedText;
  }

  private restoreVariableNames(text: string, vars: string[]): string {
    if (vars.length === 1 && vars[0] === "") {
      return text;
    }
    if (vars.length === 0) {
      return text;
    }
    let dups: { newVars: string[]; dup: string[] } = this.getDups(vars);
    dups.newVars.forEach(pair => {
      let [abc, orig] = pair.split(":");
      text = text.replace(new RegExp("\\b" + abc + "\\b", "g"), orig);
    });
    return this.restoreVariableNames(text, dups.dup);
  }

  private getDups(vars: string[]) {
    let left: string[] = new Array<string>(vars.length);
    let right: string[] = new Array<string>(vars.length);
    for (let i = 0; i < vars.length; i++) {
      [left[i], right[i]] = vars[i].split(":");
    }
    let dup: string[] = [];
    let index: number;
    for (let i = 0; i < vars.length; i++) {
      if ((index = right.indexOf(left[i])) > -1) {
        let tmp = right[index] + right[index];
        while (right.indexOf(tmp) > -1) {
          tmp += right[index];
        }
        vars[index] = left[index] + ":" + tmp;
        dup.push(tmp + ":" + right[index]);
      }
    }

    return {
      newVars: vars,
      dup: dup
    };
  }
}