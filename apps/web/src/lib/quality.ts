export const CATEGORY: Record<string, [string, string]> = {
  fall: ['Fall', 'Dhicid'],
  medication: ['Medication', 'Daawo'],
  procedure: ['Procedure', 'Hawl-gal'],
  infection: ['Infection', 'Infekshan'],
  equipment: ['Equipment', 'Qalab'],
  'patient-identification': ['Wrong patient / ID', 'Aqoonsi khaldan'],
  'pressure-injury': ['Pressure injury', 'Nabar cadaadis'],
  documentation: ['Documentation', 'Diiwaan'],
  behaviour: ['Behaviour / violence', 'Dabeecad / rabshad'],
  other: ['Other', 'Kale'],
};
export const SEVERITY: Record<string, [string, string, 'plain' | 'info' | 'warn' | 'crit']> = {
  'near-miss': ['Near miss', 'Ku dhawaad', 'plain'],
  'no-harm': ['No harm', 'Dhaawac la’aan', 'info'],
  minor: ['Minor', 'Fudud', 'info'],
  moderate: ['Moderate', 'Dhexdhexaad', 'warn'],
  severe: ['Severe', 'Daran', 'crit'],
  death: ['Death', 'Geeri', 'crit'],
};
export const INCIDENT_STATUS: Record<string, [string, string, 'warn' | 'info' | 'acc' | 'ok']> = {
  Reported: ['New', 'Cusub', 'warn'],
  Triaged: ['Triaged', 'La kala saaray', 'info'],
  Investigating: ['Investigating', 'Baaritaan', 'acc'],
  Closed: ['Closed', 'La xiray', 'ok'],
};
export const SITE: Record<string, [string, string]> = {
  bloodstream: ['Bloodstream', 'Dhiigga'],
  urinary: ['Urinary tract', 'Kaadi mareenka'],
  'surgical-site': ['Surgical site', 'Meesha qalliinka'],
  respiratory: ['Respiratory', 'Neefsashada'],
  skin: ['Skin / soft tissue', 'Maqaarka'],
  'gastro-intestinal': ['Gut', 'Caloosha'],
  other: ['Other', 'Kale'],
};
export const IPC_STATUS: Record<string, [string, string, 'warn' | 'crit' | 'plain' | 'ok']> = {
  Suspected: ['Suspected', 'La tuhunsan yahay', 'warn'],
  Confirmed: ['Confirmed', 'La xaqiijiyay', 'crit'],
  RuledOut: ['Ruled out', 'Waa la diiday', 'plain'],
  Closed: ['Closed', 'La xiray', 'ok'],
};
export const ISOLATION: Record<string, [string, string]> = {
  none: ['None', 'Midna'],
  contact: ['Contact', 'Taabasho'],
  droplet: ['Droplet', 'Dhibic'],
  airborne: ['Airborne', 'Hawo'],
};
