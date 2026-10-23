import { ChevronRight, LoaderCircle, Terminal, CircleAlert } from 'lucide-react';
import type { Message } from '../../shared/types';
import { groupMessages } from '../chat/message-groups';

export function ConversationMessages({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const groups = groupMessages(messages);
  return <>{groups.map((group, index) => {
    if (group.kind === 'message') {
      const message = group.message;
      return <div key={group.key} className={`message ${message.role} ${message.error ? 'error' : ''}`}>
        <div className="message-label">{message.role === 'user' ? '你' : message.role === 'assistant' ? 'CAStudio 助手' : '系统'}</div>
        <div className="message-body">{message.text}</div>
      </div>;
    }
    const running = busy && index === groups.length - 1;
    const errors = group.messages.filter(message => message.error).length;
    return <details className={`tool-batch ${errors ? 'has-errors' : ''}`} key={group.key}>
      <summary>
        {running ? <LoaderCircle size={13} className="spin"/> : <Terminal size={13}/>}
        <span>{running ? '正在执行' : '执行记录'}</span>
        <span className="tool-batch-count">{group.messages.length} 条命令</span>
        {errors > 0 && <span className="tool-batch-error"><CircleAlert size={12}/>{errors} 项异常</span>}
        <ChevronRight size={13} className="tool-batch-chevron"/>
      </summary>
      <div className="tool-batch-content">{group.messages.map((message, number) =>
        <section className={`tool-entry ${message.error ? 'failed' : ''}`} key={message.id} aria-label={`命令 ${number + 1}：${message.toolName || '工具调用'}`}>
          <div className="tool-entry-heading"><span className="tool-entry-number">{String(number + 1).padStart(2, '0')}</span><strong>{message.toolName || '工具调用'}</strong>{message.error && <span className="tool-entry-error">执行异常</span>}</div>
          <pre>{message.text || '暂无输出'}</pre>
        </section>
      )}</div>
    </details>;
  })}</>;
}
