/**
 * Map team / country names from TxLINE to ISO 3166-1 alpha-2 for flag assets.
 * England uses GB-ENG (St George) via special handling.
 */

const NAME_TO_ISO: Array<{ match: RegExp; iso: string; code: string }> = [
  { match: /\bunited states\b|\busa\b|\bu\.s\.a\b/, iso: "us", code: "USA" },
  { match: /\bengland\b/, iso: "gb-eng", code: "ENG" },
  { match: /\bscotland\b/, iso: "gb-sct", code: "SCO" },
  { match: /\bwales\b/, iso: "gb-wls", code: "WAL" },
  { match: /\bnorthern ireland\b/, iso: "gb-nir", code: "NIR" },
  { match: /\bunited kingdom\b|\bgreat britain\b|\buk\b/, iso: "gb", code: "GBR" },
  { match: /\bfrance\b/, iso: "fr", code: "FRA" },
  { match: /\bspain\b/, iso: "es", code: "ESP" },
  { match: /\bgermany\b/, iso: "de", code: "GER" },
  { match: /\bportugal\b/, iso: "pt", code: "POR" },
  { match: /\bnetherlands\b|\bholland\b/, iso: "nl", code: "NED" },
  { match: /\bbelgium\b/, iso: "be", code: "BEL" },
  { match: /\bitaly\b/, iso: "it", code: "ITA" },
  { match: /\bargentina\b/, iso: "ar", code: "ARG" },
  { match: /\bbrazil\b/, iso: "br", code: "BRA" },
  { match: /\buruguay\b/, iso: "uy", code: "URU" },
  { match: /\bchile\b/, iso: "cl", code: "CHI" },
  { match: /\bcolombia\b/, iso: "co", code: "COL" },
  { match: /\becuador\b/, iso: "ec", code: "ECU" },
  { match: /\bperu\b/, iso: "pe", code: "PER" },
  { match: /\bmexico\b/, iso: "mx", code: "MEX" },
  { match: /\bcanada\b/, iso: "ca", code: "CAN" },
  { match: /\bswitzerland\b/, iso: "ch", code: "SUI" },
  { match: /\baustria\b/, iso: "at", code: "AUT" },
  { match: /\bcroatia\b/, iso: "hr", code: "CRO" },
  { match: /\bserbia\b/, iso: "rs", code: "SRB" },
  { match: /\bpoland\b/, iso: "pl", code: "POL" },
  { match: /\bdenmark\b/, iso: "dk", code: "DEN" },
  { match: /\bsweden\b/, iso: "se", code: "SWE" },
  { match: /\bnorway\b/, iso: "no", code: "NOR" },
  { match: /\bfinland\b/, iso: "fi", code: "FIN" },
  { match: /\bireland\b/, iso: "ie", code: "IRL" },
  { match: /\bru\b|\brussia\b/, iso: "ru", code: "RUS" },
  { match: /\bukraine\b/, iso: "ua", code: "UKR" },
  { match: /\bturkey\b|\btürkiye\b|\bturkiye\b/, iso: "tr", code: "TUR" },
  { match: /\bjapan\b/, iso: "jp", code: "JPN" },
  { match: /\bsouth korea\b|\bkorea republic\b|\bkorea\b/, iso: "kr", code: "KOR" },
  { match: /\bchina\b/, iso: "cn", code: "CHN" },
  { match: /\baustralia\b/, iso: "au", code: "AUS" },
  { match: /\bnew zealand\b/, iso: "nz", code: "NZL" },
  { match: /\bmorocco\b/, iso: "ma", code: "MAR" },
  { match: /\bsenegal\b/, iso: "sn", code: "SEN" },
  { match: /\bghana\b/, iso: "gh", code: "GHA" },
  { match: /\bnigeria\b/, iso: "ng", code: "NGA" },
  { match: /\bcameroon\b/, iso: "cm", code: "CMR" },
  { match: /\bivory coast\b|\bcôte d'ivoire\b|\bcote d'ivoire\b/, iso: "ci", code: "CIV" },
  { match: /\balgeria\b/, iso: "dz", code: "ALG" },
  { match: /\btunisia\b/, iso: "tn", code: "TUN" },
  { match: /\begypt\b/, iso: "eg", code: "EGY" },
  { match: /\bsouth africa\b/, iso: "za", code: "RSA" },
  { match: /\bcape verde\b/, iso: "cv", code: "CPV" },
  { match: /\bcongo dr\b|\bdr congo\b|\bdemocratic republic/, iso: "cd", code: "COD" },
  { match: /\bcongo\b/, iso: "cg", code: "CGO" },
  { match: /\bsaudi arabia\b/, iso: "sa", code: "KSA" },
  { match: /\biran\b/, iso: "ir", code: "IRN" },
  { match: /\biraq\b/, iso: "iq", code: "IRQ" },
  { match: /\bqatar\b/, iso: "qa", code: "QAT" },
  { match: /\buae\b|\bunited arab emirates\b/, iso: "ae", code: "UAE" },
  { match: /\bvietnam\b/, iso: "vn", code: "VIE" },
  { match: /\bmyanmar\b|\bburma\b/, iso: "mm", code: "MYA" },
  { match: /\bthailand\b/, iso: "th", code: "THA" },
  { match: /\bindonesia\b/, iso: "id", code: "IDN" },
  { match: /\bmalaysia\b/, iso: "my", code: "MAS" },
  { match: /\bindia\b/, iso: "in", code: "IND" },
  { match: /\bpakistan\b/, iso: "pk", code: "PAK" },
  { match: /\bbangladesh\b/, iso: "bd", code: "BAN" },
  { match: /\bphilippines\b/, iso: "ph", code: "PHI" },
  { match: /\bsingapore\b/, iso: "sg", code: "SGP" },
  { match: /\bhong kong\b/, iso: "hk", code: "HKG" },
  { match: /\btaiwan\b/, iso: "tw", code: "TPE" },
  { match: /\bparaguay\b/, iso: "py", code: "PAR" },
  { match: /\bbolivia\b/, iso: "bo", code: "BOL" },
  { match: /\bvenezuela\b/, iso: "ve", code: "VEN" },
  { match: /\bcosta rica\b/, iso: "cr", code: "CRC" },
  { match: /\bpanama\b/, iso: "pa", code: "PAN" },
  { match: /\bjamaica\b/, iso: "jm", code: "JAM" },
  { match: /\bhonduras\b/, iso: "hn", code: "HON" },
  { match: /\bel salvador\b/, iso: "sv", code: "SLV" },
  { match: /\bguatemala\b/, iso: "gt", code: "GUA" },
  { match: /\bbosnia\b/, iso: "ba", code: "BIH" },
  { match: /\bslovenia\b/, iso: "si", code: "SVN" },
  { match: /\bslovakia\b/, iso: "sk", code: "SVK" },
  { match: /\bczech\b/, iso: "cz", code: "CZE" },
  { match: /\bhungary\b/, iso: "hu", code: "HUN" },
  { match: /\bromania\b/, iso: "ro", code: "ROU" },
  { match: /\bbulgaria\b/, iso: "bg", code: "BUL" },
  { match: /\bgreece\b/, iso: "gr", code: "GRE" },
  { match: /\biceland\b/, iso: "is", code: "ISL" },
  { match: /\bisrael\b/, iso: "il", code: "ISR" },
  { match: /\bnorth macedonia\b|\bmacedonia\b/, iso: "mk", code: "MKD" },
  { match: /\balbania\b/, iso: "al", code: "ALB" },
  { match: /\bgeorgia\b/, iso: "ge", code: "GEO" },
  { match: /\barmenia\b/, iso: "am", code: "ARM" },
  { match: /\bazerbaijan\b/, iso: "az", code: "AZE" },
  { match: /\bkazakhstan\b/, iso: "kz", code: "KAZ" },
  { match: /\buzbekistan\b/, iso: "uz", code: "UZB" },
  { match: /\biran\b/, iso: "ir", code: "IRN" },
];

export type CountryFlag = {
  iso: string;
  code: string;
  /** flagcdn path segment e.g. fr, gb-eng */
  flagPath: string;
};

export function resolveCountry(name?: string | null): CountryFlag | null {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  if (!key || key === "home" || key === "away" || key === "tbd") return null;

  for (const row of NAME_TO_ISO) {
    if (row.match.test(key)) {
      return { iso: row.iso, code: row.code, flagPath: row.iso };
    }
  }
  return null;
}

/** flagcdn.com — works for iso + subdivision (gb-eng) */
export function flagImageUrl(flagPath: string, width = 80): string {
  return `https://flagcdn.com/w${width}/${flagPath}.png`;
}

/** Unicode regional-indicator flag for 2-letter ISO (not for gb-eng). */
export function flagEmoji(iso2: string): string | null {
  if (!iso2 || iso2.length !== 2) return null;
  const upper = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return String.fromCodePoint(
    ...[...upper].map((c) => 0x1f1e6 - 65 + c.charCodeAt(0))
  );
}
