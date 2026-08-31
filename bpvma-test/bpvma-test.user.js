// ==UserScript==
// @name         BPVMA Event-Driven Test
// @namespace    local-test
// @version      2.3
// @description  Event-driven automation test — LOCAL MOCK PAGE ONLY (Best Pop → LISA, Best K-Pop → BLACKPINK)
// @match        file:///C:/Users/Alice/Desktop/mock-voting-page.html
// @match        file:///*/mock-voting-page.html
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {

    'use strict';


    /* =========================================================
       CONFIGURATION
       ========================================================= */

    const TEST_EMAIL = 'test@example.com';

    /*
     * Change this to 10 for normal testing
     * or 20 for Power/Double testing.
     *
     * This is the ASSERTION, not a reading of
     * the page — the run must fail if the page
     * reports a different total.
     */
    const REQUIRED_VOTES = 10;

    /*
     * Who to vote for, per category — mirrors the real
     * slot map in vote-extension/README.md:
     *
     *     Best Pop    → C1 = LISA
     *     Best K-pop  → A1 = BLACKPINK
     *
     * Best K-pop lists LISA too (F1), so the target here
     * is not simply "the BLACKPINK-ish button" — the run
     * must hit the right one of the two.
     */

    const CATEGORIES = [
        { name: 'Best Pop',   candidate: 'LISA' },
        { name: 'Best K-Pop', candidate: 'BLACKPINK' }
    ];

    const TIMEOUT = 5000;


    /*
     * =========================================================
       INTERNAL STATE
       ========================================================= */

    const seenTimestamps = new Set();

    let runStarted = false;


    /*
     * =========================================================
       LOGGING
       ========================================================= */

    function log(message, type = 'info') {

        const time =
            new Date().toLocaleTimeString();

        console.log(
            `[${time}] [${type.toUpperCase()}] ${message}`
        );


        const logBox =
            document.getElementById(
                'event-log'
            );

        if (!logBox) return;


        const line =
            document.createElement(
                'div'
            );


        line.textContent =
            `[${time}] ${message}`;


        if (type === 'success') {

            line.style.color =
                '#00ff88';

        } else if (type === 'error') {

            line.style.color =
                '#ff5555';

        } else {

            line.style.color =
                '#80f2ff';

        }


        logBox.appendChild(line);

        logBox.scrollTop =
            logBox.scrollHeight;

    }


    /*
     * =========================================================
       PANEL
       ========================================================= */

    function createPanel() {

        if (
            document.getElementById(
                'event-panel'
            )
        ) {
            return;
        }


        const panel =
            document.createElement(
                'div'
            );


        panel.id =
            'event-panel';


        panel.style.cssText = `
            position:fixed;
            right:20px;
            bottom:20px;
            width:370px;
            background:#050505;
            color:#80f2ff;
            border:1px solid #00e5ff;
            border-radius:6px;
            padding:15px;
            z-index:999999;
            font-family:monospace;
            box-shadow:0 0 20px rgba(0,229,255,.25);
        `;


        panel.innerHTML = `

            <div style="
                font-weight:bold;
                color:#00e5ff;
                margin-bottom:8px;
            ">
                EVENT-DRIVEN TEST
            </div>

            <div id="event-state"
                 style="margin-bottom:8px;">
                IDLE
            </div>

            <div id="event-progress"
                 style="
                    margin-bottom:8px;
                    color:#aaa;
                 ">
                0 / ${CATEGORIES.length}
            </div>

            <div id="event-log"
                 style="
                    height:220px;
                    overflow:auto;
                    font-size:11px;
                    border-top:1px solid #333;
                    padding-top:8px;
                 ">
            </div>
        `;


        document.body.appendChild(
            panel
        );

    }


    function setState(state) {

        const element =
            document.getElementById(
                'event-state'
            );


        if (element) {

            element.textContent =
                state;

        }


        log(
            `STATE → ${state}`
        );

    }


    function updateProgress(
        completed
    ) {

        const element =
            document.getElementById(
                'event-progress'
            );


        if (element) {

            element.textContent =
                `${completed} / ${CATEGORIES.length}`;

        }

    }


    /*
     * =========================================================
       GENERIC CONDITION WAITER
       ========================================================= */

    function waitForCondition(
        condition,
        timeout = TIMEOUT,
        interval = 25
    ) {

        return new Promise(
            resolve => {

                const start =
                    Date.now();


                function check() {

                    let result =
                        false;


                    try {

                        result =
                            Boolean(
                                condition()
                            );

                    } catch (_) {

                        result =
                            false;

                    }


                    if (result) {

                        resolve({
                            success:true,
                            reason:'condition_met'
                        });

                        return;

                    }


                    if (
                        Date.now() -
                        start >=
                        timeout
                    ) {

                        resolve({
                            success:false,
                            reason:'timeout'
                        });

                        return;

                    }


                    setTimeout(
                        check,
                        interval
                    );

                }


                check();

            }
        );

    }


    /*
     * =========================================================
       MUTATION OBSERVER CONDITION WAITER
       ========================================================= */

    function waitForDOMCondition(
        condition,
        timeout = TIMEOUT
    ) {

        return new Promise(
            resolve => {

                let finished =
                    false;


                let timer;


                function finish(
                    result
                ) {

                    if (finished)
                        return;


                    finished =
                        true;


                    observer.disconnect();


                    clearTimeout(
                        timer
                    );


                    resolve(
                        result
                    );

                }


                const observer =
                    new MutationObserver(
                        () => {

                            if (finished)
                                return;


                            try {

                                if (
                                    condition()
                                ) {

                                    finish({
                                        success:true,
                                        reason:
                                            'dom_condition_met'
                                    });

                                }

                            } catch (_) {}

                        }
                    );


                observer.observe(
                    document.body,
                    {
                        childList:true,
                        subtree:true,
                        characterData:true,
                        attributes:true
                    }
                );


                /*
                 * Check immediately.
                 */

                try {

                    if (
                        condition()
                    ) {

                        finish({
                            success:true,
                            reason:
                                'already_true'
                        });

                        return;

                    }

                } catch (_) {}


                timer =
                    setTimeout(
                        () => {

                            finish({
                                success:false,
                                reason:'timeout'
                            });

                        },
                        timeout
                    );

            }
        );

    }


    /*
     * =========================================================
       DOM HELPERS
       ========================================================= */

    function isVisible(
        element
    ) {

        if (!element)
            return false;


        const rect =
            element.getBoundingClientRect();


        return (
            rect.width > 0 &&
            rect.height > 0 &&
            !element.disabled
        );

    }


    function findLoginButton() {

        return [
            ...document.querySelectorAll(
                'button'
            )
        ].find(
            button =>
                button
                    .textContent
                    .trim()
                    .toLowerCase() ===
                'log in'
        );

    }


    function findCategory(
        name
    ) {

        return [
            ...document.querySelectorAll(
                '.category-header'
            )
        ].find(
            button =>
                button
                    .textContent
                    .trim()
                    .toLowerCase() ===
                name.toLowerCase()
        );

    }


    function findCategoryContainer(
        name
    ) {

        return [
            ...document.querySelectorAll(
                '.category'
            )
        ].find(
            category =>
                category.dataset.category ===
                name
        );

    }


    function findCandidateButton(
        categoryName,
        candidate
    ) {

        const category =
            findCategoryContainer(
                categoryName
            );


        if (!category)
            return null;


        return category.querySelector(
            '.plus[data-candidate="' +
            candidate +
            '"]'
        );

    }


    function findSubmit(
        categoryName
    ) {

        const category =
            findCategoryContainer(
                categoryName
            );


        if (!category)
            return null;


        return category.querySelector(
            '.submit'
        );

    }


    /*
     * The count for ONE nominee — not the category's
     * first .vote-count, which would now silently read
     * whichever nominee happens to be listed first.
     */

    function getVoteCount(
        categoryName,
        candidate
    ) {

        const category =
            findCategoryContainer(
                categoryName
            );


        if (!category)
            return 0;


        const count =
            category.querySelector(
                '[data-count-for="' +
                candidate +
                '"]'
            );


        return parseInt(
            count?.textContent || '0',
            10
        ) || 0;

    }


    /*
     * =========================================================
       CLICK
       ========================================================= */

    function clickElement(
        element
    ) {

        if (!element)
            return false;


        element.scrollIntoView({
            behavior:'instant',
            block:'center'
        });


        element.click();


        return true;

    }


    /*
     * =========================================================
       PRE-FLIGHT
       =========================================================
     *
     * The page's TEST MODE selector and REQUIRED_VOTES above
     * are set independently. When they disagree the submit
     * button never enables and the run dies with a bare
     * SUBMIT_TIMEOUT, which reads like a script bug.
     *
     * This is advisory only — REQUIRED_VOTES stays the
     * assertion, so a genuine mismatch still fails the run.
     */

    function preflight() {

        const modeDisplay =
            document.getElementById(
                'mode-display'
            );


        if (!modeDisplay)
            return;


        const pageRequired =
            parseInt(
                modeDisplay.textContent,
                10
            );


        if (
            !Number.isFinite(
                pageRequired
            )
        ) {
            return;
        }


        if (
            pageRequired !==
            REQUIRED_VOTES
        ) {

            log(
                `MODE MISMATCH — page requires ${pageRequired}, script expects ${REQUIRED_VOTES}. ` +
                `Set the page's TEST MODE (or REQUIRED_VOTES) so they agree; this run is expected to fail.`,
                'error'
            );

        }

    }


    /*
     * =========================================================
       LOGIN
       ========================================================= */

    async function login() {

        setState(
            'LOGIN_STARTED'
        );


        const email =
            document.getElementById(
                'email'
            );


        const loginButton =
            findLoginButton();


        if (!email ||
            !loginButton) {

            log(
                'Login controls not found.',
                'error'
            );

            return false;

        }


        email.value =
            TEST_EMAIL;


        clickElement(
            loginButton
        );


        log(
            'Login action performed.'
        );


        /*
         * Wait for the ACTUAL DOM state.
         */

        const result =
            await waitForDOMCondition(
                () => {

                    const status =
                        document.getElementById(
                            'status'
                        );


                    return (
                        status &&
                        status.textContent
                            .toLowerCase()
                            .includes(
                                'logged in as'
                            )
                    );

                }
            );


        if (!result.success) {

            setState(
                'LOGIN_TIMEOUT'
            );

            log(
                'Login confirmation never appeared.',
                'error'
            );

            return false;

        }


        setState(
            'LOGIN_CONFIRMED'
        );


        log(
            'Login confirmed by DOM.',
            'success'
        );


        return true;

    }


    /*
     * =========================================================
       MOCK VOTE CONFIRMATION
       ========================================================= */

    function waitForMockVote(
        categoryName,
        expectedCandidate
    ) {

        return new Promise(
            resolve => {

                let finished =
                    false;


                let timer;


                function cleanup() {

                    window.removeEventListener(
                        'mock-vote-completed',
                        listener
                    );


                    clearTimeout(
                        timer
                    );

                }


                function finish(
                    result
                ) {

                    if (finished)
                        return;


                    finished =
                        true;


                    cleanup();


                    resolve(
                        result
                    );

                }


                function listener(
                    event
                ) {

                    const detail =
                        event.detail;


                    if (!detail)
                        return;


                    /*
                     * Must be the correct category.
                     */

                    if (
                        detail.category !==
                        categoryName
                    ) {
                        return;
                    }


                    /*
                     * Timestamp de-duplication.
                     */

                    if (
                        detail.timestamp &&
                        seenTimestamps.has(
                            detail.timestamp
                        )
                    ) {

                        log(
                            `${categoryName}: duplicate timestamp ignored.`
                        );

                        return;

                    }


                    if (
                        detail.timestamp
                    ) {

                        seenTimestamps.add(
                            detail.timestamp
                        );

                    }


                    /*
                     * Verify the expected
                     * number of selections.
                     */

                    if (
                        Number(
                            detail.total
                        ) !==
                        REQUIRED_VOTES
                    ) {

                        finish({
                            success:false,
                            reason:
                                'wrong_vote_total'
                        });

                        return;

                    }


                    /*
                     * Verify candidate — the votes must
                     * have gone to THIS category's target
                     * nominee, and to nobody else.
                     *
                     * detail.candidate is "MIXED" when the
                     * page tallied a split, which fails here.
                     */

                    if (
                        detail.candidate !==
                        expectedCandidate
                    ) {

                        finish({
                            success:false,
                            reason:
                                `wrong_candidate (voted ${detail.candidate}, wanted ${expectedCandidate})`
                        });

                        return;

                    }


                    /*
                     * And the target's own tally must be
                     * the full required amount.
                     */

                    const candidateVotes =
                        Number(
                            (detail.votes || {})[
                                expectedCandidate
                            ] || 0
                        );


                    if (
                        candidateVotes !==
                        REQUIRED_VOTES
                    ) {

                        finish({
                            success:false,
                            reason:
                                `wrong_candidate_total (${expectedCandidate} got ${candidateVotes}, wanted ${REQUIRED_VOTES})`
                        });

                        return;

                    }


                    /*
                     * HTTP-like 2xx verification.
                     */

                    if (
                        detail.statusCode >=
                        200 &&
                        detail.statusCode <
                        300
                    ) {

                        finish({
                            success:true,
                            reason:
                                'network_confirmed'
                        });

                    } else {

                        /*
                         * Name the mock's server mode. A 500
                         * here is the FIXTURE rejecting the
                         * vote, not a fault in the run — say
                         * so, so it is not read as a bug.
                         */

                        finish({
                            success:false,
                            reason:
                                `server_failure — the mock server returned ` +
                                `${detail.statusCode} (server mode: ${detail.serverMode || 'unknown'}). ` +
                                `The run correctly refused to report success. ` +
                                `Use #${REQUIRED_VOTES}/success for a clean pass.`
                        });

                    }

                }


                window.addEventListener(
                    'mock-vote-completed',
                    listener
                );


                timer =
                    setTimeout(
                        () => {

                            finish({
                                success:false,
                                reason:
                                    'timeout'
                            });

                        },
                        TIMEOUT
                    );

            }
        );

    }


    /*
     * =========================================================
       PROCESS ONE CATEGORY
       ========================================================= */

    async function processCategory(
        categoryName,
        candidateName
    ) {

        setState(
            `CATEGORY_START: ${categoryName} → ${candidateName}`
        );


        const category =
            findCategory(
                categoryName
            );


        const container =
            findCategoryContainer(
                categoryName
            );


        if (!category ||
            !container) {

            log(
                `${categoryName}: category not found.`,
                'error'
            );

            return false;

        }


        /*
         * -----------------------------------------------------
         * OPEN CATEGORY
         * -----------------------------------------------------
         */

        if (
            !container.classList.contains(
                'open'
            )
        ) {

            setState(
                `OPENING: ${categoryName}`
            );


            clickElement(
                category
            );


            const opened =
                await waitForDOMCondition(
                    () =>
                        container.classList.contains(
                            'open'
                        )
                );


            if (!opened.success) {

                setState(
                    `OPEN_TIMEOUT: ${categoryName}`
                );

                return false;

            }

        }


        log(
            `${categoryName}: category opened.`,
            'success'
        );


        /*
         * -----------------------------------------------------
         * SELECT THE TARGET NOMINEE
         * -----------------------------------------------------
         */

        setState(
            `SELECTING: ${categoryName} → ${candidateName}`
        );


        const target =
            findCandidateButton(
                categoryName,
                candidateName
            );


        if (!target) {

            log(
                `${categoryName}: ${candidateName} button not found.`,
                'error'
            );

            return false;

        }


        /*
         * We do NOT assume the number of
         * milliseconds required.
         *
         * We select until the DOM reports
         * the required number.
         */

        let safety =
            REQUIRED_VOTES + 5;


        while (
            getVoteCount(
                categoryName,
                candidateName
            ) <
            REQUIRED_VOTES
        ) {

            if (
                safety-- <= 0
            ) {

                log(
                    `${categoryName}: vote-count safety limit reached.`,
                    'error'
                );

                return false;

            }


            /*
             * Read the baseline BEFORE clicking.
             *
             * The page updates .vote-count
             * synchronously inside its click
             * handler, so reading after the click
             * already sees the new value — deriving
             * "expected" from it would wait for a
             * count one higher than any click can
             * produce, and every selection would
             * time out.
             */

            const before =
                getVoteCount(
                    categoryName,
                    candidateName
                );


            clickElement(
                target
            );


            /*
             * Wait until the DOM confirms
             * that this selection registered.
             */

            const countChanged =
                await waitForDOMCondition(
                    () =>
                        getVoteCount(
                            categoryName,
                            candidateName
                        ) >=
                        before + 1
                );


            if (
                !countChanged.success
            ) {

                log(
                    `${categoryName}: selection was not confirmed.`,
                    'error'
                );

                return false;

            }

        }


        const finalCount =
            getVoteCount(
                categoryName,
                candidateName
            );


        if (
            finalCount !==
            REQUIRED_VOTES
        ) {

            log(
                `${categoryName}: expected ${REQUIRED_VOTES} for ${candidateName}, got ${finalCount}.`,
                'error'
            );

            return false;

        }


        log(
            `${categoryName}: ${finalCount}/${REQUIRED_VOTES} selections confirmed for ${candidateName}.`,
            'success'
        );


        /*
         * -----------------------------------------------------
         * WAIT FOR SUBMIT
         * -----------------------------------------------------
         */

        setState(
            `WAITING_FOR_SUBMIT: ${categoryName}`
        );


        const submit =
            findSubmit(
                categoryName
            );


        if (!submit) {

            log(
                `${categoryName}: submit button missing.`,
                'error'
            );

            return false;

        }


        const submitReady =
            await waitForDOMCondition(
                () =>
                    !submit.disabled &&
                    isVisible(submit)
            );


        if (!submitReady.success) {

            setState(
                `SUBMIT_TIMEOUT: ${categoryName}`
            );


            log(
                `${categoryName}: submit never enabled — the page requires more ` +
                `selections than REQUIRED_VOTES (${REQUIRED_VOTES}).`,
                'error'
            );


            return false;

        }


        log(
            `${categoryName}: submit is enabled.`,
            'success'
        );


        /*
         * -----------------------------------------------------
         * LISTEN BEFORE SUBMIT
         * -----------------------------------------------------
         */

        const confirmationPromise =
            waitForMockVote(
                categoryName,
                candidateName
            );


        setState(
            `SUBMISSION_STARTED: ${categoryName}`
        );


        clickElement(
            submit
        );


        /*
         * -----------------------------------------------------
         * NETWORK CONFIRMATION
         * -----------------------------------------------------
         */

        const confirmation =
            await confirmationPromise;


        if (!confirmation.success) {

            setState(
                `SUBMISSION_FAILED: ${categoryName}`
            );


            log(
                `${categoryName}: ${confirmation.reason}`,
                'error'
            );


            return false;

        }


        log(
            `${categoryName}: 2xx mock response confirmed.`,
            'success'
        );


        /*
         * -----------------------------------------------------
         * UI CONFIRMATION
         * -----------------------------------------------------
         */

        setState(
            `VERIFYING_UI: ${categoryName}`
        );


        const uiConfirmation =
            await waitForDOMCondition(
                () => {

                    const status =
                        document.getElementById(
                            'status'
                        );


                    return (
                        status &&
                        status.textContent
                            .includes(
                                'We got your vote today'
                            )
                    );

                }
            );


        if (
            !uiConfirmation.success
        ) {

            setState(
                `UI_CONFIRMATION_FAILED: ${categoryName}`
            );


            log(
                `${categoryName}: network succeeded but UI confirmation was missing.`,
                'error'
            );


            return false;

        }


        /*
         * -----------------------------------------------------
         * CATEGORY SUCCESS
         * -----------------------------------------------------
         */

        setState(
            `CATEGORY_CONFIRMED: ${categoryName}`
        );


        log(
            `${categoryName}: COMPLETE — ${REQUIRED_VOTES} votes to ${candidateName}.`,
            'success'
        );


        return true;

    }


    /*
     * =========================================================
       MAIN RUNNER
       ========================================================= */

    async function runTest() {

        if (runStarted)
            return;


        runStarted =
            true;


        log(
            `Starting event-driven test. Required votes: ${REQUIRED_VOTES}`
        );


        preflight();


        /*
         * LOGIN
         */

        const loggedIn =
            await login();


        if (!loggedIn) {

            setState(
                'RUN_FAILED'
            );

            return;

        }


        /*
         * PROCESS EVERY CATEGORY.
         *
         * IMPORTANT:
         * We only count a category as complete
         * if processCategory() returns true.
         */

        let completedCategories =
            0;


        for (
            const entry
            of CATEGORIES
        ) {

            const success =
                await processCategory(
                    entry.name,
                    entry.candidate
                );


            if (!success) {

                setState(
                    `RUN_STOPPED: ${entry.name}`
                );


                log(
                    `Run stopped because ${entry.name} was not confirmed.`,
                    'error'
                );


                return;

            }


            completedCategories++;


            updateProgress(
                completedCategories
            );


            /*
             * Small logical transition only.
             *
             * There is deliberately no arbitrary
             * "wait 750ms" here.
             */

            log(
                `${entry.name}: confirmed. Moving to next category.`,
                'success'
            );

        }


        /*
         * -----------------------------------------------------
         * ACCOUNT SUCCESS
         * -----------------------------------------------------
         *
         * This can ONLY happen after every category
         * returned true.
         */

        if (
            completedCategories !==
            CATEGORIES.length
        ) {

            setState(
                'ACCOUNT_NOT_COMPLETE'
            );


            log(
                'Not all categories were confirmed.',
                'error'
            );


            return;

        }


        setState(
            'ACCOUNT_COMPLETE'
        );


        log(
            `ACCOUNT SUCCESS — ${completedCategories}/${CATEGORIES.length} categories confirmed.`,
            'success'
        );

    }


    /*
     * =========================================================
       INITIALIZATION
       ========================================================= */

    createPanel();


    log(
        'Test userscript initialized.'
    );


    log(
        `Configured for ${REQUIRED_VOTES} selections per category: ` +
        CATEGORIES.map(
            entry =>
                `${entry.name} → ${entry.candidate}`
        ).join(', ')
    );


    /*
     * Let the page finish its own initialization,
     * then start.
     */

    setTimeout(
        () => {

            runTest()
                .catch(
                    error => {

                        console.error(
                            error
                        );


                        setState(
                            'UNEXPECTED_ERROR'
                        );


                        log(
                            error.message ||
                            String(error),
                            'error'
                        );

                    }
                );

        },
        500
    );

})();
