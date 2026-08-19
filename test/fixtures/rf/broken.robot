*** Settings ***
Library    Browser

*** Test Cases ***
Fails With Locator Timeout
    New Browser    chromium    headless=${True}
    New Page    http://127.0.0.1:8123/
    Wait For Elements State    css=#does-not-exist    visible    timeout=2s
