/** Date and time in the hospital's timezone, e.g. "Thu 8 Jan, 10:00". */
export const when = (d: string, lang: 'en' | 'so') =>
  new Intl.DateTimeFormat(lang === 'so' ? 'so-SO' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Mogadishu' }).format(new Date(d));

export interface Thread {
  id: string;
  subject: string;
  status: string;
  awaiting: 'staff' | 'patient' | null;
  lastAt: string;
  patient: { id: string; mrn: string; name: string } | null;
  messages: { from: 'patient' | 'staff'; byName: string; at: string; text: string }[];
}
