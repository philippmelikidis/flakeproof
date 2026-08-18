*** Settings ***
Documentation       Locators und Keywords für den Seiten-Header von testgilde.de.
...                 Hier liegt das gesamte Wissen über den Aufbau der Seite — die
...                 Testfälle in ``tests/header.robot`` beschreiben nur noch das Verhalten.
...
...                 Ändert sich das Markup der Website, muss nur diese Datei angepasst werden.

Library             Browser
Library             Collections


*** Variables ***
# --- Zieladresse -------------------------------------------------------------
${BASE_URL}                     https://www.testgilde.de/

# --- Browser-Konfiguration ---------------------------------------------------
# Unterhalb von ca. 1280px klappt das Hauptmenü in einen Burger-Button.
# Für den Test der Desktop-Navigation brauchen wir daher ein breites Fenster.
${BROWSER}                      chromium
${HEADLESS}                     ${True}
${VIEWPORT_WIDTH}               ${1920}
${VIEWPORT_HEIGHT}              ${1080}

# --- Locators ----------------------------------------------------------------
# Der Header ist eine Avada/Fusion-Komponente. ``.fusion-tb-header`` selbst hat
# die Höhe 0 (die Kinder sind absolut positioniert) — die sichtbare Kopfleiste
# ist ``.fusion-builder-row-1``. Logo und CTA existieren doppelt im DOM (helle
# und dunkle Variante), deshalb filtert ``:visible`` auf das jeweils gezeigte
# Element. Ohne diesen Filter würde Playwright im Strict Mode abbrechen.
${HEADER}                       css=.fusion-tb-header .fusion-builder-row-1
${HEADER_LOGO}                  css=.fusion-tb-header .fusion-builder-row-1 .fusion-image-element a img:visible
${HEADER_LOGO_LINK}             css=.fusion-tb-header .fusion-builder-row-1 .fusion-image-element a:visible
${HEADER_CTA}                   css=.fusion-tb-header .fusion-builder-row-1 a.fusion-button.open-contact

# ``menu-main-navigation`` ist die von WordPress vergebene Menü-ID und damit
# deutlich stabiler als die generierten Fusion-Klassen.
${MAIN_MENU}                    css=ul#menu-main-navigation
${MAIN_MENU_ITEMS}              css=ul#menu-main-navigation > li > a

# Cookie-Consent (Borlabs Cookie)
${CONSENT_REJECT_BUTTON}        css=.brlbs-btn-accept-only-essential

# --- Erwartete Inhalte -------------------------------------------------------
# Diese Werte sind die eigentliche Prüfgrundlage. Ändert sich die Navigation
# fachlich, wird hier angepasst — nicht in den Testfällen.
@{ERWARTETE_MENUEPUNKTE}        Leistungen    Lösungen    Unternehmen    Karriere
${ERWARTETER_CTA_TEXT}          Jetzt anfragen
${ERWARTETE_LOGO_DATEI}         testgilde-logo


*** Keywords ***
Startseite Öffnen
    [Documentation]    Öffnet die TestGilde-Startseite in einem frischen Browser-Kontext
    ...    und räumt den Cookie-Banner weg, damit er den Header nicht überdeckt.
    New Browser    ${BROWSER}    headless=${HEADLESS}
    New Context    viewport={'width': ${VIEWPORT_WIDTH}, 'height': ${VIEWPORT_HEIGHT}}
    New Page    ${BASE_URL}
    Cookie-Banner Ablehnen
    Wait For Elements State    ${HEADER}    visible    timeout=15s

Cookie-Banner Ablehnen
    [Documentation]    Klickt „Ablehnen" im Consent-Dialog (nur technisch notwendige Cookies).
    ...    Der Banner erscheint nur bei einem frischen Browser-Profil — fehlt er,
    ...    läuft der Test ohne Fehler weiter.
    ${banner_sichtbar}=    Run Keyword And Return Status
    ...    Wait For Elements State    ${CONSENT_REJECT_BUTTON}    visible    timeout=10s
    IF    ${banner_sichtbar}
        Click    ${CONSENT_REJECT_BUTTON}
        Wait For Elements State    ${CONSENT_REJECT_BUTTON}    hidden    timeout=10s
        Log    Cookie-Banner abgelehnt.    level=INFO
    ELSE
        Log    Kein Cookie-Banner sichtbar — Schritt übersprungen.    level=INFO
    END

Browser Schließen
    [Documentation]    Räumt alle Browser-Instanzen der Suite auf.
    Close Browser    ALL

Sichtbare Menüpunkte Auslesen
    [Documentation]    Liefert die Beschriftungen der Hauptmenüpunkte als Liste,
    ...    in genau der Reihenfolge, in der sie im Header stehen.
    ${anzahl}=    Get Element Count    ${MAIN_MENU_ITEMS}
    @{beschriftungen}=    Create List
    FOR    ${index}    IN RANGE    ${anzahl}
        ${text}=    Get Text    ${MAIN_MENU_ITEMS} >> nth=${index}
        Append To List    ${beschriftungen}    ${text.strip()}
    END
    RETURN    ${beschriftungen}

Menüpunkt Sollte Verlinken Auf
    [Documentation]    Prüft, dass der Hauptmenüpunkt mit der Beschriftung ``${beschriftung}``
    ...    auf ``${erwartetes_ziel}`` zeigt.
    [Arguments]    ${beschriftung}    ${erwartetes_ziel}
    # Der Menüpunkt wird über seine Position angesprochen, nicht über einen
    # Text-Selektor: Die Beschriftung steckt in einem verschachtelten <span>,
    # weshalb Playwrights ``:text-is()`` am <a> vorbeigreifen würde.
    ${beschriftungen}=    Sichtbare Menüpunkte Auslesen
    List Should Contain Value    ${beschriftungen}    ${beschriftung}
    ...    msg=Menüpunkt "${beschriftung}" fehlt im Hauptmenü — gefunden wurden ${beschriftungen}.
    ${position}=    Get Index From List    ${beschriftungen}    ${beschriftung}
    ${ziel}=    Get Attribute    ${MAIN_MENU_ITEMS} >> nth=${position}    href
    Should Be Equal    ${ziel}    ${erwartetes_ziel}
    ...    msg=Menüpunkt "${beschriftung}" verlinkt auf "${ziel}" statt auf "${erwartetes_ziel}".
    ...    values=${False}
