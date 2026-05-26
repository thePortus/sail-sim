import {
  Component, inject, signal, computed, effect, ViewChild, ElementRef, untracked,
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

      <!-- Tab bar -->
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
            <span class="chat-msg-from" [class.chat-msg-from--mine]="msg.from === myCallsign">
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
          (keydown)="$event.stopImmediatePropagation()"
          (keydown.enter)="sendMessage()"
          (keydown.escape)="chatInput.blur()"
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
export class ChatComponent {
  private multiplayerService = inject(MultiplayerService);
  private authService        = inject(AuthService);

  myCallsign = '';
  activeTab  = signal<string>('global');
  dmTabs     = signal<string[]>([]);
  inputValue = '';

  @ViewChild('messagesContainer') private messagesContainer!: ElementRef<HTMLElement>;

  constructor() {
    try {
      const raw = this.authService.getUserDetails();
      if (raw) this.myCallsign = JSON.parse(raw)?.callsign ?? '';
    } catch { /* */ }

    // Auto-open a DM tab when a new DM arrives or is sent.
    // Read dmTabs with untracked() so closing a tab doesn't re-trigger this effect.
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

    // Scroll to bottom whenever the displayed message list changes
    effect(() => {
      this.displayedMessages(); // track signal
      setTimeout(() => {
        const el = this.messagesContainer?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      }, 0);
    });
  }

  displayedMessages = computed(() => {
    const tab  = this.activeTab();
    const msgs = this.multiplayerService.chatMessages();
    if (tab === 'global') return msgs.filter(m => m.chatType === 'global');
    return msgs.filter(m =>
      m.chatType === 'dm' &&
      (m.from === tab || (m.from === this.myCallsign && m.to === tab))
    );
  });

  inputPlaceholder = computed(() => {
    const tab = this.activeTab();
    return tab === 'global' ? 'Message all…  (/t name for DM)' : `Message ${tab}…`;
  });

  switchTab(tab: string): void {
    this.activeTab.set(tab);
  }

  closeTab(callsign: string, event: Event): void {
    event.stopPropagation();
    this.dmTabs.update(tabs => tabs.filter(t => t !== callsign));
    if (this.activeTab() === callsign) this.activeTab.set('global');
  }

  sendMessage(): void {
    const text = this.inputValue.trim();
    if (!text) return;

    const tab = this.activeTab();
    if (tab !== 'global' && !text.startsWith('/t ')) {
      // In a DM tab — automatically prefix the target callsign
      this.multiplayerService.sendChat(`/t ${tab} ${text}`);
    } else {
      this.multiplayerService.sendChat(text);
    }

    this.inputValue = '';
  }
}
