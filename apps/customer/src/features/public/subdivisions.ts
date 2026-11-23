/**
 * The provinces and territories /register asks for (ISO 3166-2), for the countries where a block covers part of the
 * country only: Canada (Ontario) and Ukraine (Crimea, Sevastopol, Donetsk, Luhansk). Names in English, as ISO publishes
 * them. The list says nothing about which region is blocked: svc-identity decides that from its own lists, and refuses
 * a country it needs a province for with `identity.subdivision_required` whether or not this page lists one.
 */
const SUBDIVISIONS: Readonly<Record<string, ReadonlyArray<readonly [code: string, name: string]>>> = {
  CA: [
    ['CA-AB', 'Alberta'],
    ['CA-BC', 'British Columbia'],
    ['CA-MB', 'Manitoba'],
    ['CA-NB', 'New Brunswick'],
    ['CA-NL', 'Newfoundland and Labrador'],
    ['CA-NT', 'Northwest Territories'],
    ['CA-NS', 'Nova Scotia'],
    ['CA-NU', 'Nunavut'],
    ['CA-ON', 'Ontario'],
    ['CA-PE', 'Prince Edward Island'],
    ['CA-QC', 'Quebec'],
    ['CA-SK', 'Saskatchewan'],
    ['CA-YT', 'Yukon'],
  ],
  UA: [
    ['UA-71', 'Cherkasy'],
    ['UA-74', 'Chernihiv'],
    ['UA-77', 'Chernivtsi'],
    ['UA-43', 'Crimea'],
    ['UA-12', 'Dnipropetrovsk'],
    ['UA-14', 'Donetsk'],
    ['UA-26', 'Ivano-Frankivsk'],
    ['UA-63', 'Kharkiv'],
    ['UA-65', 'Kherson'],
    ['UA-68', 'Khmelnytskyi'],
    ['UA-35', 'Kirovohrad'],
    ['UA-30', 'Kyiv (city)'],
    ['UA-32', 'Kyiv'],
    ['UA-09', 'Luhansk'],
    ['UA-46', 'Lviv'],
    ['UA-48', 'Mykolaiv'],
    ['UA-51', 'Odesa'],
    ['UA-53', 'Poltava'],
    ['UA-56', 'Rivne'],
    ['UA-40', 'Sevastopol'],
    ['UA-59', 'Sumy'],
    ['UA-61', 'Ternopil'],
    ['UA-05', 'Vinnytsia'],
    ['UA-07', 'Volyn'],
    ['UA-21', 'Zakarpattia'],
    ['UA-23', 'Zaporizhzhia'],
    ['UA-18', 'Zhytomyr'],
  ],
};

/** The provinces or territories of `country` the page offers, or none. */
export function subdivisionOptions(country: string): Array<{ code: string; name: string }> {
  return (SUBDIVISIONS[country.trim().toUpperCase()] ?? []).map(([code, name]) => ({ code, name }));
}
