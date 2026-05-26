import {
  Component, inject, signal, computed, effect, ViewChild, ElementRef, untracked,
  HostBinding, AfterViewInit, OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MultiplayerService } from '../../services/multiplayer.service';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="chat-panel">

      <!-- Drag handle (grab here to reposition) -->
      <div class="chat-drag-handle" (mousedown)="onDragStart($event)">
        <span class="chat-drag-grip">⣿</span>
        <span class="chat-drag-title">Chat</span>
        <span class="chat-drag-hint">/friend &lt;name&gt; to befriend</span>
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
      <div class="chat-messages" #messagesContainer>
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
          (keydown.enter)="sendMessage()"
          (keydown.escape)="chatInput.blur()"
          (keydown)="$event.stopImmediatePropagation()"
          [placeholder]="inputPlaceholder()"
          maxlength="512"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="chat-send-btn" (click)="sendMessage()">▶</button>
      </div>

    </div>
  `,
})
export class ChatComponent implements AfterViewInit, OnDestroy {
  private multiplayerService = inject(MultiplayerService);
  private authService        = inject(AuthService);
  private elRef              = inject(ElementRef);

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

  // ── Drag state ────────────────────────────────────────────────────────────
  private isDragging    = false;
  private dragStartX    = 0;
  private dragStartY    = 0;
  private dragStartLeft = 0;
  private dragStartTop  = 0;

  private readonly mouseMoveHandler = (e: MouseEvent) => this.onDragMove(e);
  private readonly mouseUpHandler   = ()               => this.onDragEnd();

  constructor() {
    try {
      const raw = this.authService.getUserDetails();
      if (raw) this.myCallsign = JSON.parse(raw)?.callsign ?? '';
    } catch { /* */ }

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
    // Centre the panel vertically at first render
    const el = this.elRef.nativeElement as HTMLElement;
    this.posTop = Math.max(10, Math.round((window.innerHeight - el.offsetHeight) / 2));
  }

  ngOnDestroy(): void {
    window.removeEventListener('mousemove', this.mouseMoveHandler);
    window.removeEventListener('mouseup',   this.mouseUpHandler);
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
    return tab === 'global' ? 'Message all…  /t <name>  /friend <name>' : `Message ${tab}…`;
  });

  switchTab(tab: string): void { this.activeTab.set(tab); }

  closeTab(callsign: string, event: Event): void {
    event.stopPropagation();
    this.dmTabs.update(tabs => tabs.filter(t => t !== callsign));
    if (this.activeTab() === callsign) this.activeTab.set('global');
  }

  sendMessage(): void {
    const text = this.inputValue.trim();
    if (!text) return;
    this.inputValue = '';

    // ── Client-side commands (no server round-trip) ────────────────────────
    if (text === '/friends') {
      const online = this.multiplayerService.mutualFriends();
      if (online.length === 0) {
        this.addSystemMessage('No mutual friends currently online.');
      } else {
        this.addSystemMessage(`Online friends (${online.length}): ${online.join(', ')}`);
      }
      return;
    }

    if (text === '/help') {
      this.addSystemMessage(
        'Commands: ' +
        '/t <name> <msg> — DM a player  |  ' +
        '/friend <name> — toggle friend  |  ' +
        '/friends — list online friends  |  ' +
        '/help — show this help',
      );
      return;
    }

    // ── Server-bound messages ──────────────────────────────────────────────
    const tab = this.activeTab();
    if (tab !== 'global' && !text.startsWith('/t ') && !text.startsWith('/friend ')) {
      this.multiplayerService.sendChat(`/t ${tab} ${text}`);
    } else {
      this.multiplayerService.sendChat(text);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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
