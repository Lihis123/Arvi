# Arvi

Kevyt, nopea ja suomenkielinen Android-puhelimelle suunniteltu PWA-sovellus tulevien arvioitavien töiden hallintaan.

## Ominaisuudet

- **Aikajärjestyksessä oleva työlista**: Näyttää tulevat työt allekkain määräajan (deadline) mukaan. Jokaisella työllä on nimi, tila, deadline (päivä + valinnainen kellonaika), huomiot sekä värikoodattu painoarvo (*Matala / Normaali / Tärkeä / Kriittinen*).
- **Helppo tilan vaihto svaippaamalla**: Svaippaa korttia oikealle siirtyäksesi seuraavaan tilaan tai vasemmalle palataksesi edelliseen — mukana kevyt animaatio, tuntopalaute ja **Kumoa**-toiminto.
- **Muokattavat tilat**: Oletustilat ovat *Aloittamatta → Työn alla → Valmis*, mutta asetuksissa voit lisätä uusia tiloja, muuttaa nimiä, värejä, järjestystä ja sitä, mitkä tilat piilotetaan *Piilota tehdyt* -valinnalla.
- **Toimii itsenäisesti offline-tilassa**: Ensimmäisen latauksen jälkeen sovellus toimii täysin itsenäisesti puhelimessasi ilman verkkoyhteyttä.
- **Päivitykset vain pyynnöstä**: Sovellus ei päivity taustalla ilman lupaasi. Asetuksissa on erillinen **Tarkista päivitykset** -painike, joka tarkistaa uuden version ja tekee ennen päivitystä aina automaattisen varmuuskopion.
- **Luotettavat paikalliset varmuuskopiot**:
  - Valitse puhelimeltasi paikallinen kansio (*Asetukset → Varmuuskopiot*), jonne Arvi luo oman `Arvi-varmuuskopiot`-alikansion ja tallentaa varmuuskopion **automaattisesti jokaisen muutoksen jälkeen** porrastetulla säilytyksellä (uusin + 7 päivittäistä + 4 viikoittaista + 6 kuukausittaista = enintään 18 tiedostoa).
  - Lisäksi laitteen sisäiset palautuspisteet (IndexedDB) ja manuaalinen `.json`-vienti/tuonti.
  - Versioitu tietomalli (`schemaVersion`) ja tarkistussumma varmistavat, että vanhat varmuuskopiot toimivat aina myös uusien versioiden kanssa.

## Asennus Android-puhelimeen

1. Julkaise tämä repositorio GitHub Pagesissa (*Settings → Pages → Source: GitHub Actions*).
2. Avaa GitHub Pages -osoite Android-puhelimen **Chrome-selaimella** (suositus Chrome 132+, jotta suora kansiokohtainen automaattinen varmuuskopiointi toimii).
3. Valitse Chromen valikosta **Asenna sovellus** / **Lisää aloitusnäyttöön**.
4. Avaa **Arvi** kotinäytöltä, mene kohtaan **Asetukset → Varmuuskopiot** ja valitse paikallinen varmuuskopiokansio.

## Uuden version julkaiseminen GitHubiin

Kun haluat julkaista käyttäjille päivityksen:

1. Päivitä versionumero kolmeen paikkaan:
   - `version.json` (`version`, `releasedAt`, `changelog`)
   - `js/constants.js` (`APP_VERSION`)
   - `sw.js` (`CACHE_VERSION`)
2. Jos tietomalliin tulee rakenteellisia muutoksia, nosta `SCHEMA_VERSION` ja lisää migraatiofunktio tiedostoon `js/migrations.js` (varmistaen taaksepäin yhteensopivuuden vanhojen varmuuskopioiden kanssa).
3. Pushaa muutokset `main`-haaraan — GitHub Pages julkaisee uuden version automaattisesti, ja käyttäjät voivat hakea sen itse napilla **Asetukset → Päivitykset → Tarkista päivitykset**.

## Testit

```bash
node --test tests/migrations.test.mjs
```
