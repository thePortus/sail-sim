import {
  Component, inject, signal, computed, effect, ViewChild, ElementRef, untracked,
  HostBinding, AfterViewInit, OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MultiplayerService } from '../../services/multiplayer.service';
import { AuthService } from '../../../services/auth.service';
import { ApiService } from '../../../services/api.service';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="chat-panel"
         [style.width.px]="panelWidth"
         [style.font-size.px]="fontSize">

      <!-- Drag handle (grab here to reposition) -->
      <div class="chat-drag-handle" (mousedown)="onDragStart($event)">
        <span class="chat-drag-grip">⣿</span>
        <span class="chat-drag-title">Chat</span>
        <span class="chat-drag-hint">/help</span>
        <div class="chat-font-btns" (mousedown)="$event.stopPropagation()">
          <button class="chat-font-btn" (click)="adjustFont(-1)" title="Smaller text">A−</button>
          <button class="chat-font-btn" (click)="adjustFont(1)"  title="Larger text">A+</button>
        </div>
      </div>

      <!-- Tab bar (tabs are not part of the drag zone) -->
      <div class="chat-tabs">
        <button class="chat-tab" [class.chat-tab--active]="activeTab() === 'global'"
                (click)="switchTab('global')">
          Main
        </button>
        @for (tab of dmTabs(); track tab) {
          <button class="chat-tab" [class.chat-tab--active]="activeTab() === tab"
                  (click)="switchTab(tab)">
            {{ tab }}
            <span class="chat-tab-close" (click)="closeTab(tab, $event)">×</span>
          </button>
        }
      </div>

      <!-- Message list -->
      <div class="chat-messages" #messagesContainer [style.height.px]="messagesHeight">
        @for (msg of displayedMessages(); track msg.id) {
          <div class="chat-msg">
            <span class="chat-msg-from"
                  [class.chat-msg-from--mine]="msg.from === myCallsign"
                  [class.chat-msg-from--system]="msg.from === '⚓ System'">
              {{ msg.from === myCallsign ? 'You' : msg.from }}:
            </span>
            <span class="chat-msg-text">{{ msg.text }}</span>
          </div>
        }
        @if (displayedMessages().length === 0) {
          <div class="chat-empty">No messages yet.</div>
        }
      </div>

      <!-- Input row -->
      <div class="chat-input-row">
        <input
          #chatInput
          type="text"
          class="chat-input"
          [(ngModel)]="inputValue"
          (keydown.enter)="sendMessage(); chatInput.blur()"
          (keydown.escape)="chatInput.blur()"
          (keydown)="$event.stopImmediatePropagation()"
          [placeholder]="inputPlaceholder()"
          maxlength="512"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="chat-send-btn" (click)="sendMessage()">▶</button>
      </div>

      <!-- Resize handle (drag to resize width + message-area height) -->
      <div class="chat-resize-handle" (mousedown)="onResizeStart($event)" title="Drag to resize">◢</div>

    </div>
  `,
})
export class ChatComponent implements AfterViewInit, OnDestroy {
  private multiplayerService = inject(MultiplayerService);
  private authService        = inject(AuthService);
  private elRef              = inject(ElementRef);
  private api                = inject(ApiService);

  // ── Position (HostBinding drives absolute placement) ─────────────────────
  @HostBinding('style.left.px') posLeft = 20;
  @HostBinding('style.top.px')  posTop  = 200;

  // ── Chat state ────────────────────────────────────────────────────────────
  myCallsign    = '';
  activeTab     = signal<string>('global');
  dmTabs        = signal<string[]>([]);
  inputValue    = '';
  /** Client-only system messages — never sent to the server. */
  private localMessages = signal<import('../../models').ChatMessage[]>([]);

  @ViewChild('messagesContainer') private messagesContainer!: ElementRef<HTMLElement>;
  @ViewChild('chatInput')         private chatInputRef!: ElementRef<HTMLInputElement>;

  // ── Drag state ────────────────────────────────────────────────────────────
  private isDragging    = false;
  private dragStartX    = 0;
  private dragStartY    = 0;
  private dragStartLeft = 0;
  private dragStartTop  = 0;

  private readonly mouseMoveHandler = (e: MouseEvent) => this.onDragMove(e);
  private readonly mouseUpHandler   = ()               => this.onDragEnd();

  // ── Size / font (persisted to localStorage) ───────────────────────────────
  panelWidth     = 310;   // px
  messagesHeight = 160;   // px (the scrolling log area)
  fontSize       = 12;    // px — drives the whole panel via [style.font-size]
  private isResizing      = false;
  private resizeStartX     = 0;
  private resizeStartY     = 0;
  private resizeStartW     = 0;
  private resizeStartH     = 0;
  private readonly resizeMoveHandler = (e: MouseEvent) => this.onResizeMove(e);
  private readonly resizeUpHandler   = ()              => this.onResizeEnd();

  // Role flags — gate admin/owner command help and access.
  isAdmin = false;
  isOwner = false;

  constructor() {
    try {
      const raw = this.authService.getUserDetails();
      if (raw) {
        const data = JSON.parse(raw);
        this.myCallsign = data?.callsign ?? '';
        const role = (data?.role ?? '').toLowerCase();
        this.isOwner = role === 'owner';
        this.isAdmin = role === 'admin' || role === 'owner';
      }
    } catch { /* */ }

    this.loadChatPrefs();

    effect(() => {
      const msgs = this.multiplayerService.chatMessages();
      if (msgs.length === 0) return;
      const last = msgs[msgs.length - 1];
      if (last.chatType !== 'dm') return;
      const other = last.from === this.myCallsign ? (last.to ?? '') : last.from;
      if (other && !untracked(() => this.dmTabs()).includes(other)) {
        this.dmTabs.update(tabs => [...tabs, other]);
      }
    });

    effect(() => {
      this.displayedMessages();
      setTimeout(() => {
        const el = this.messagesContainer?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      }, 0);
    });
  }

  ngAfterViewInit(): void {
    // Keep initial HostBinding values stable in dev mode to avoid NG0100.
  }

  ngOnDestroy(): void {
    window.removeEventListener('mousemove', this.mouseMoveHandler);
    window.removeEventListener('mouseup',   this.mouseUpHandler);
    window.removeEventListener('mousemove', this.resizeMoveHandler);
    window.removeEventListener('mouseup',   this.resizeUpHandler);
  }

  /** Programmatically focus the chat input (used by the global Enter / "/" hotkeys). */
  focusInput(prefill?: string): void {
    if (prefill) this.inputValue = prefill;
    setTimeout(() => this.chatInputRef?.nativeElement.focus(), 0);
  }

  // ── Drag handlers ─────────────────────────────────────────────────────────

  onDragStart(e: MouseEvent): void {
    this.isDragging    = true;
    this.dragStartX    = e.clientX;
    this.dragStartY    = e.clientY;
    this.dragStartLeft = this.posLeft;
    this.dragStartTop  = this.posTop;
    window.addEventListener('mousemove', this.mouseMoveHandler);
    window.addEventListener('mouseup',   this.mouseUpHandler);
    e.preventDefault(); // stops text selection while dragging
  }

  private onDragMove(e: MouseEvent): void {
    if (!this.isDragging) return;
    this.posLeft = this.dragStartLeft + (e.clientX - this.dragStartX);
    this.posTop  = this.dragStartTop  + (e.clientY - this.dragStartY);
    // Clamp so panel can't escape the viewport completely
    const el  = this.elRef.nativeElement as HTMLElement;
    const maxL = window.innerWidth  - 60;
    const maxT = window.innerHeight - 40;
    this.posLeft = Math.max(-el.offsetWidth  + 60, Math.min(maxL, this.posLeft));
    this.posTop  = Math.max(0,                      Math.min(maxT, this.posTop));
  }

  private onDragEnd(): void {
    this.isDragging = false;
    window.removeEventListener('mousemove', this.mouseMoveHandler);
    window.removeEventListener('mouseup',   this.mouseUpHandler);
  }

  // ── Resize + font handlers ──────────────────────────────────────────────────

  onResizeStart(e: MouseEvent): void {
    this.isResizing  = true;
    this.resizeStartX = e.clientX;
    this.resizeStartY = e.clientY;
    this.resizeStartW = this.panelWidth;
    this.resizeStartH = this.messagesHeight;
    window.addEventListener('mousemove', this.resizeMoveHandler);
    window.addEventListener('mouseup',   this.resizeUpHandler);
    e.preventDefault();
    e.stopPropagation();
  }

  private onResizeMove(e: MouseEvent): void {
    if (!this.isResizing) return;
    this.panelWidth     = Math.max(240, Math.min(760, this.resizeStartW + (e.clientX - this.resizeStartX)));
    this.messagesHeight = Math.max(90,  Math.min(560, this.resizeStartH + (e.clientY - this.resizeStartY)));
  }

  private onResizeEnd(): void {
    this.isResizing = false;
    window.removeEventListener('mousemove', this.resizeMoveHandler);
    window.removeEventListener('mouseup',   this.resizeUpHandler);
    this.saveChatPrefs();
  }

  adjustFont(delta: number): void {
    this.fontSize = Math.max(9, Math.min(22, this.fontSize + delta));
    this.saveChatPrefs();
  }

  private loadChatPrefs(): void {
    try {
      const p = JSON.parse(localStorage.getItem('ignis_chat_prefs') ?? '{}');
      if (typeof p.w === 'number') this.panelWidth     = Math.max(240, Math.min(760, p.w));
      if (typeof p.h === 'number') this.messagesHeight = Math.max(90,  Math.min(560, p.h));
      if (typeof p.f === 'number') this.fontSize       = Math.max(9,   Math.min(22,  p.f));
    } catch { /* defaults */ }
  }

  private saveChatPrefs(): void {
    localStorage.setItem('ignis_chat_prefs', JSON.stringify({
      w: this.panelWidth, h: this.messagesHeight, f: this.fontSize,
    }));
  }

  // ── Chat logic ────────────────────────────────────────────────────────────

  displayedMessages = computed(() => {
    const tab    = this.activeTab();
    const server = this.multiplayerService.chatMessages();
    const local  = this.localMessages();
    // Local (system) messages always show on the global tab only
    const all    = tab === 'global'
      ? [...server.filter(m => m.chatType === 'global'), ...local]
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      : server.filter(m =>
          m.chatType === 'dm' &&
          (m.from === tab || (m.from === this.myCallsign && m.to === tab))
        );
    return all;
  });

  inputPlaceholder = computed(() => {
    const tab = this.activeTab();
    return tab === 'global' ? 'Message all…  (/help for commands)' : `Message ${tab}…`;
  });

  switchTab(tab: string): void { this.activeTab.set(tab); }

  closeTab(callsign: string, event: Event): void {
    event.stopPropagation();
    this.dmTabs.update(tabs => tabs.filter(t => t !== callsign));
    if (this.activeTab() === callsign) this.activeTab.set('global');
  }

  // Commands handled entirely on the server (passed through verbatim).
  private readonly SERVER_COMMANDS = [
    't', 'friend', 'promote', 'demote', 'kick', 'ban', 'unban', 'reloadassets',
    'godmode', 'teleport', 'teleporto', 'repair', 'givegold', 'mast',
  ];

  sendMessage(): void {
    const text = this.inputValue.trim();
    if (!text) return;
    this.inputValue = '';

    // ── Strict slash-command parsing ───────────────────────────────────────
    // Anything beginning with '/' is treated as a command. Unknown commands are
    // rejected locally (never broadcast). Plain text is chat.
    if (text.startsWith('/')) {
      const sp  = text.indexOf(' ');
      const cmd = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? '' : text.slice(sp + 1).trim();
      this.runCommand(cmd, arg, text);
      return;
    }

    // ── Plain chat ─────────────────────────────────────────────────────────
    const tab = this.activeTab();
    if (tab !== 'global') {
      // In a DM tab, plain text whispers to that tab's player (quote spaced names).
      this.multiplayerService.sendChat(`/t ${this.quoteName(tab)} ${text}`);
    } else {
      this.multiplayerService.sendChat(text);
    }
  }

  /** Dispatch a parsed slash-command. `raw` is the original full text. */
  private runCommand(cmd: string, arg: string, raw: string): void {
    switch (cmd) {
      case 'help':
        this.showHelp();
        return;

      case 'friends': {
        const online = this.multiplayerService.mutualFriends();
        this.addSystemMessage(online.length === 0
          ? 'No mutual friends currently online.'
          : `Online friends (${online.length}): ${online.join(', ')}`);
        return;
      }

      case 'mute':
      case 'block':
      case 'unmute':
      case 'unblock': {
        const name = this.parseFirstArg(arg);
        if (!name) { this.addSystemMessage(`Usage: /${cmd} "<callsign>"`); return; }
        const removing = cmd === 'unmute' || cmd === 'unblock';
        this.multiplayerService.setBlocked(name, !removing);
        this.addSystemMessage(removing
          ? `You have unblocked "${name}".`
          : `You have blocked "${name}". You will no longer see their messages.`);
        return;
      }

      case 'setpass': {
        // Self: /setpass <newpass>   |   Admin on another: /setpass "<callsign>" <newpass>
        this.handleSetPass(arg);
        return;
      }

      case 'export':
        this.handleExport();
        return;

      // Server-handled commands — pass through verbatim.
      default:
        if (this.SERVER_COMMANDS.includes(cmd)) {
          this.multiplayerService.sendChat(raw);
        } else {
          this.addSystemMessage(`Command not recognized: /${cmd}. Type /help for a list.`);
        }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Wrap a callsign in double quotes if it contains a space, for command parsing. */
  private quoteName(name: string): string {
    return name.includes(' ') ? `"${name}"` : name;
  }

  /** Extract the first argument, honouring double-quotes for spaced callsigns. */
  private parseFirstArg(arg: string): string {
    const s = arg.trim();
    if (!s) return '';
    if (s[0] === '"') {
      const end = s.indexOf('"', 1);
      return end === -1 ? '' : s.slice(1, end).trim();
    }
    const sp = s.indexOf(' ');
    return (sp === -1 ? s : s.slice(0, sp)).trim();
  }

  /** Split into { target, rest } honouring quotes. rest may be empty. */
  private parseTargetAndRest(arg: string): { target: string; rest: string } {
    const s = arg.trim();
    if (s[0] === '"') {
      const end = s.indexOf('"', 1);
      if (end === -1) return { target: '', rest: '' };
      return { target: s.slice(1, end).trim(), rest: s.slice(end + 1).trim() };
    }
    const sp = s.indexOf(' ');
    if (sp === -1) return { target: s, rest: '' };
    return { target: s.slice(0, sp).trim(), rest: s.slice(sp + 1).trim() };
  }

  /** Show the command list, one command per line; admin commands only for admins. */
  private showHelp(): void {
    const lines = [
      'Commands:',
      '/t "<name>" <msg> — direct-message a player',
      '/friend "<name>" — toggle a friend',
      '/friends — list online friends',
      '/mute "<name>" (or /block) — hide a player\'s messages',
      '/unmute "<name>" (or /unblock) — unhide them',
      '/setpass <new password> — change your own password',
      '/help — show this help',
    ];
    if (this.isAdmin) {
      lines.push(
        '— Admin —',
        '/promote "<name>" — make a user an Admin',
        '/demote "<name>" — make an Admin a regular user',
        '/kick "<name>" — disconnect a player',
        '/ban "<name>" — ban a player from logging in',
        '/unban "<name>" — lift a ban',
        '/setpass "<name>" <new password> — reset a regular user\'s password',
        '/reloadassets — re-fetch updated vessel models for all players',
        '/godmode — toggle invulnerability for yourself',
        '/teleport "<name>" <X> <Y> — move a player to map coords (X=E/W, Y=N/S)',
        '/teleporto "<name>" — jump yourself to open water beside a player',
        '/repair "<name>" — fully repair a player\'s ship',
        '/givegold "<name>" <amount> — gift gold to a player',
        '/mast [hp] — set your own mast HP for testing (no arg = dismast; auto jury-rigs to 50% in 45s)',
      );
    }
    if (this.isOwner) {
      lines.push(
        '— Owner —',
        '/export — download all user accounts as a backup JSON',
      );
    }
    lines.push(
      '— Shortcuts —',
      '`  (backtick) — toggle the FPS / ping readout',
      'Ctrl+Shift+O — switch between the new (FFT) and classic ocean',
      'Tip: wrap callsigns containing spaces in double quotes, e.g. /t "Red Sail" ahoy',
    );
    this.addSystemMessage(lines.join('\n'));
  }

  /** /setpass — self (one arg) or admin resetting another (quoted name + password). */
  private handleSetPass(arg: string): void {
    const { target, rest } = this.parseTargetAndRest(arg);
    // If there's a remaining password after a (quoted/first) token, treat token as a
    // target callsign (admin resetting someone else). Otherwise the whole arg is the
    // new password for the caller themselves.
    let callsign: string;
    let newPass: string;
    if (rest) { callsign = target; newPass = rest; }
    else      { callsign = this.myCallsign; newPass = arg.trim(); }

    if (!newPass) { this.addSystemMessage('Usage: /setpass <new password>  (admins: /setpass "<name>" <new password>)'); return; }

    this.api.putTypeRequest(`user/setpass/${encodeURIComponent(callsign)}`, { password: newPass })
      .subscribe({
        next: () => this.addSystemMessage(
          callsign === this.myCallsign
            ? 'Your password has been updated.'
            : `Password for "${callsign}" has been reset.`),
        error: (e) => this.addSystemMessage(
          `Could not change password: ${e?.error?.message ?? 'unauthorized or not found'}.`),
      });
  }

  /** /export (Owner only) — download all user accounts as a backup JSON file. */
  private handleExport(): void {
    if (!this.isOwner) { this.addSystemMessage('Command not recognized: /export. Type /help for a list.'); return; }
    this.api.getBlobRequest('user/export').subscribe({
      next: (blob: any) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'users.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.addSystemMessage('User backup exported.');
      },
      error: (e) => this.addSystemMessage(`Export failed: ${e?.error?.message ?? 'unauthorized'}.`),
    });
  }

  private addSystemMessage(text: string): void {
    const msg: import('../../models').ChatMessage = {
      id:        `local-${Date.now()}-${Math.random()}`,
      from:      '⚓ System',
      text,
      timestamp: new Date(),
      chatType:  'global',
    };
    this.localMessages.update(msgs => [...msgs.slice(-49), msg]);
  }
}
