// Windows toast 通知。标题/正文先 sanitizeText，再经环境变量传入 PowerShell（不进命令行拼接）。
import { execFileSync } from 'node:child_process';
import { sanitizeText } from './config.mjs';

const PS = `
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n=$t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:QDC_TOAST_TITLE)) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($env:QDC_TOAST_MSG)) | Out-Null
$v=$t.GetElementsByTagName('visual').Item(0)
$v.SetAttribute('duration', $env:QDC_TOAST_DURATION)
if ($env:QDC_TOAST_SILENT -ne '1') {
  $a=$t.CreateElement('audio'); $a.SetAttribute('src','ms-winsoundevent:Notification.Default'); $t.DocumentElement.AppendChild($a) | Out-Null
}
$tn=[Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('qoder-daily-claim').Show($tn)
`;

export function toast(cfg, title, msg) {
  if (!cfg?.notify?.enabled) return false;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', PS], {
      stdio: 'ignore',
      timeout: 15_000,
      env: {
        ...process.env,
        QDC_TOAST_TITLE: sanitizeText(title, 80),
        QDC_TOAST_MSG: sanitizeText(msg, 180),
        QDC_TOAST_DURATION: cfg.notify.duration === 'short' ? 'short' : 'long',
        QDC_TOAST_SILENT: cfg.notify.sound ? '0' : '1',
      },
    });
    return true;
  } catch { return false; }
}
