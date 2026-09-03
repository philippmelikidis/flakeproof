*** Settings ***
Library    Browser
Suite Teardown    Close Browser    ALL

*** Test Cases ***
Cta Appears Quickly
    New Browser    chromium    headless=${True}
    New Page    %{FIXTURE_URL}
    Wait For Elements State    css=#cta    visible    timeout=2500ms
