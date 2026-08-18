*** Settings ***
Documentation       Prüft den sichtbaren Seiten-Header von testgilde.de:
...                 Logo, Hauptnavigation, Call-to-Action und Sticky-Verhalten.

Resource            ../resources/testgilde_header.resource

Suite Setup         Startseite Öffnen
Suite Teardown      Browser Schließen

Test Tags           header    smoke


*** Test Cases ***
Header Wird Angezeigt
    [Documentation]    Die Kopfleiste ist vorhanden und sichtbar.
    Get Element States    ${HEADER}    contains    visible

Logo Wird Angezeigt Und Verlinkt Auf Die Startseite
    [Documentation]    Das TestGilde-Logo ist sichtbar und führt zurück zur Startseite.
    Get Element States    ${HEADER_LOGO}    contains    visible

    ${logo_quelle}=    Get Attribute    ${HEADER_LOGO}    src
    Should Contain    ${logo_quelle}    ${ERWARTETE_LOGO_DATEI}
    ...    msg=Logo-Grafik ist "${logo_quelle}" und enthält nicht "${ERWARTETE_LOGO_DATEI}".
    ...    values=${False}

    ${logo_ziel}=    Get Attribute    ${HEADER_LOGO_LINK}    href
    Should Be Equal    ${logo_ziel}    ${BASE_URL}
    ...    msg=Logo verlinkt auf "${logo_ziel}" statt auf "${BASE_URL}".
    ...    values=${False}

Hauptmenü Enthält Alle Punkte In Der Richtigen Reihenfolge
    [Documentation]    Genau die vier erwarteten Menüpunkte, in der erwarteten Reihenfolge.
    ...    Ein zusätzlicher, fehlender oder vertauschter Punkt lässt den Test fehlschlagen.
    Get Element States    ${MAIN_MENU}    contains    visible

    ${gefundene_punkte}=    Sichtbare Menüpunkte Auslesen
    Lists Should Be Equal    ${gefundene_punkte}    ${ERWARTETE_MENUEPUNKTE}
    ...    msg=Hauptmenü zeigt ${gefundene_punkte} statt ${ERWARTETE_MENUEPUNKTE}.
    ...    values=${False}

Hauptmenü Verlinkt Auf Die Richtigen Ziele
    [Documentation]    Jeder Menüpunkt zeigt auf die für ihn vorgesehene Seite.
    [Template]    Menüpunkt Sollte Verlinken Auf
    Leistungen     /leistungen/
    Lösungen       /loesungen/
    Unternehmen    /unternehmen/ueber-uns
    Karriere       /karriere/

Call-To-Action-Button Wird Angezeigt
    [Documentation]    Der Anfrage-Button im Header ist sichtbar und beschriftet.
    ...    Der Button öffnet ein Kontakt-Overlay und hat daher bewusst kein href.
    Get Element States    ${HEADER_CTA}    contains    visible

    ${beschriftung}=    Get Text    ${HEADER_CTA}
    Should Be Equal    ${beschriftung.strip()}    ${ERWARTETER_CTA_TEXT}
    ...    msg=CTA-Button ist mit "${beschriftung.strip()}" statt "${ERWARTETER_CTA_TEXT}" beschriftet.
    ...    values=${False}

Header Bleibt Beim Scrollen Sichtbar
    [Documentation]    Der Header ist sticky: Nach dem Scrollen klebt er weiterhin
    ...    oben am Fensterrand und bleibt damit erreichbar.
    Scroll By    vertical=1200
    Wait For Elements State    ${HEADER}    visible    timeout=10s

    ${abstand_von_oben}=    Get BoundingBox    ${HEADER}    y
    Should Be True    ${abstand_von_oben} < 100
    ...    msg=Header steht nach dem Scrollen ${abstand_von_oben}px vom oberen Rand entfernt und klebt damit nicht mehr oben.

    [Teardown]    Scroll To    vertical=top
