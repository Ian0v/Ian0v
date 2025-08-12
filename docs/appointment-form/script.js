/* Minimal, production-ready client script
   NOTE: Replace the endpoint URLs with your backend endpoints.
   Endpoints used:
   - GET  /api/hold?t=TOKEN
   - GET  /api/availability?date=YYYY-MM-DD&token=TOKEN&service=...
   - POST /api/book
*/

(() => {
  const api = {
    hold: '/api/hold',               // GET ?t=TOKEN
    availability: '/api/availability', // GET ?date=...&token=...&service=...
    book: '/api/book'                // POST JSON { token, name, phone, ... }
  };

  const form = document.getElementById('bookingForm');
  const dateInput = document.getElementById('date');
  const timeSelect = document.getElementById('time');
  const nameInput = document.getElementById('name');
  const phoneInput = document.getElementById('phone');
  const emailInput = document.getElementById('email');
  const serviceSelect = document.getElementById('service');
  const notesInput = document.getElementById('notes');
  const submitBtn = document.getElementById('submitBtn');
  const submitText = document.getElementById('submitText');
  const spinner = document.getElementById('spinner');
  const holdTimerEl = document.getElementById('holdTimer');
  const errorsEl = document.getElementById('errors');
  const statusLive = document.getElementById('status');

  let hold = null;           // { token, expires_at (ISO), prefill }
  let countdownInterval = null;
  const DRAFT_KEY_PREFIX = 'booking_draft_';

  function qs(name){
    return new URL(location.href).searchParams.get(name);
  }

  function setStatus(msg){
    statusLive.textContent = msg;
  }

  function showError(msg){
    errorsEl.textContent = msg;
    submitBtn.disabled = false;
    spinner.classList.remove('visible');
    setStatus(msg);
  }

  function clearError(){
    errorsEl.textContent = '';
    setStatus('');
  }

  function disableSubmit(){
    submitBtn.disabled = true;
    spinner.classList.add('visible');
  }

  function enableSubmit(){
    submitBtn.disabled = false;
    spinner.classList.remove('visible');
  }

  function parseISOToLocalTime(isoStr){
    const d = new Date(isoStr);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }

  function startCountdown(expiresAtISO){
    if (countdownInterval) { clearInterval(countdownInterval); }
    function tick(){
      const now = Date.now();
      const expires = new Date(expiresAtISO).getTime();
      const diff = Math.max(0, Math.floor((expires - now) / 1000));
      if (diff <= 0){
        holdTimerEl.textContent = 'expired';
        clearInterval(countdownInterval);
        hold = null;
        showError('Your hold has expired. Please request a new booking link.');
        return;
      }
      const mm = String(Math.floor(diff/60)).padStart(2,'0');
      const ss = String(diff%60).padStart(2,'0');
      holdTimerEl.textContent = `${mm}:${ss}`;
    }
    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  function saveDraft(){
    try {
      const key = (hold && hold.token) ? DRAFT_KEY_PREFIX + hold.token : DRAFT_KEY_PREFIX + 'anon';
      const payload = {
        name: nameInput.value,
        phone: phoneInput.value,
        email: emailInput.value,
        service: serviceSelect.value,
        stylist: document.getElementById('stylist').value,
        date: dateInput.value,
        time: timeSelect.value,
        notes: notesInput.value,
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(key, JSON.stringify(payload));
    } catch(e){
      // ignore storage errors
      console.warn('draft save failed', e);
    }
  }

  function loadDraft(){
    try {
      const key = (hold && hold.token) ? DRAFT_KEY_PREFIX + hold.token : DRAFT_KEY_PREFIX + 'anon';
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.name) nameInput.value = data.name;
      if (data.phone) phoneInput.value = data.phone;
      if (data.email) emailInput.value = data.email;
      if (data.service) serviceSelect.value = data.service;
      if (data.stylist) document.getElementById('stylist').value = data.stylist;
      if (data.date) dateInput.value = data.date;
      if (data.time) timeSelect.value = data.time;
      if (data.notes) notesInput.value = data.notes;
    } catch(e){
      console.warn('draft load failed', e);
    }
  }

  /* Populate time select from an array of ISO slots returned by backend */
  function populateTimeOptions(slots){
    timeSelect.innerHTML = '<option value="">Choose a time</option>';
    if (!slots || slots.length === 0){
      const opt = document.createElement('option'); opt.value=''; opt.textContent='No available times';
      timeSelect.appendChild(opt);
      return;
    }
    for (const s of slots){
      const local = parseISOToLocalTime(s);
      const opt = document.createElement('option');
      opt.value = s; // keep ISO on value so we know exact moment
      opt.textContent = local;
      timeSelect.appendChild(opt);
    }
  }

  /* Fetch hold information from backend using token in URL */
  async function fetchHoldFromServer(token){
    try {
      const res = await fetch(`${api.hold}?t=${encodeURIComponent(token)}`, { method: 'GET', credentials: 'same-origin' });
      if (!res.ok) {
        throw new Error('Hold not available');
      }
      const data = await res.json();
      return data;
    } catch(e){
      console.error(e);
      return null;
    }
  }

  /* Request available slots for a date & service */
  async function fetchAvailableSlots(dateStr){
    clearError();
    if (!dateStr) return;
    try {
      disableSubmit();
      setStatus('Checking availability…');
      const tokenParam = hold ? `&token=${encodeURIComponent(hold.token)}` : '';
      const service = encodeURIComponent(serviceSelect.value || '');
      const url = `${api.availability}?date=${encodeURIComponent(dateStr)}${tokenParam}&service=${service}`;
      const res = await fetch(url, { method: 'GET', credentials: 'same-origin' });
      if (!res.ok) throw new Error('Could not load slots');
      const data = await res.json(); // expected { slots: [ISOStrings...] }
      populateTimeOptions(data.slots || []);
      enableSubmit();
      setStatus('Slots updated');
    } catch(e){
      console.error(e);
      showError('Unable to fetch available times. Try again.');
      populateTimeOptions([]);
      enableSubmit();
    }
  }

  /* Submit booking payload to server */
  async function submitBooking(payload){
    try {
      const res = await fetch(api.book, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'same-origin',
        body: JSON.stringify(payload)
      });
      return res;
    } catch(e){
      console.error('booking error', e);
      throw e;
    }
  }

  /* Pre-fill from hold.prefill and start countdown */
  function prepareFromHold(h){
    if (!h) return;
    hold = h;
    // prefill fields if provided
    if (h.prefill){
      if (h.prefill.name) nameInput.value = h.prefill.name;
      if (h.prefill.phone) phoneInput.value = h.prefill.phone;
      if (h.prefill.email) emailInput.value = h.prefill.email;
      if (h.prefill.service) serviceSelect.value = h.prefill.service;
    }
    if (h.expires_at) startCountdown(h.expires_at);
    // change browser history so Back doesn't bring the token-laden page
    history.replaceState({}, document.title, window.location.pathname);
    loadDraft();
  }

  /* Validate Monday lock: returns true if OK */
  function validateBusinessDay(dateStr){
    const d = new Date(dateStr + 'T00:00:00'); // local date
    const dow = d.getDay(); // 0=Sun,1=Mon,...6=Sat
    // Closed on Monday => dow === 1
    return dow !== 1;
  }

  async function init(){
    // Hook: parse token in URL
    const token = qs('t');
    if (token){
      setStatus('Validating booking link…');
      const serverHold = await fetchHoldFromServer(token);
      if (!serverHold || !serverHold.valid){
        showError('Booking link expired or invalid. Please request a new link from the chat.');
      } else {
        prepareFromHold(serverHold);
      }
    } else {
      // No token: still allow booking but warn user to use chat link for hold
      setStatus('Open booking — no hold token. Use the chat link for a faster experience.');
      loadDraft();
    }

    // Date picker: prevent Mondays and fetch slots when date changed
    dateInput.addEventListener('change', async (e) => {
      const val = dateInput.value;
      if (!val) return;
      if (!validateBusinessDay(val)){
        alert('We are closed on Mondays. Please choose another date.');
        dateInput.value = '';
        populateTimeOptions([]);
        return;
      }
      await fetchAvailableSlots(val);
      saveDraft();
    });

    // Autosave draft on input
    [nameInput, phoneInput, emailInput, serviceSelect, notesInput, document.getElementById('stylist')].forEach(el => {
      el.addEventListener('input', () => { saveDraft(); });
    });

    // Populate generic times on service change if a date is selected
    serviceSelect.addEventListener('change', () => {
      if (dateInput.value) fetchAvailableSlots(dateInput.value);
    });

    // Form submission
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clearError();

      // native validation
      if (!form.checkValidity()){
        showError('Please complete all required fields correctly.');
        return;
      }

      // guard: hold token required if you want guaranteed slot reservation
      if (!hold){
        // optional: create a soft hold or warn user
        const ok = confirm('You do not have a reservation hold. Submitting may fail if another customer books the same time. Proceed?');
        if (!ok) return;
      }

      // disable UI
      disableSubmit();
      submitText.textContent = 'Securing your booking…';
      setStatus('Attempting to book — please wait');

      const payload = {
        token: hold ? hold.token : null,
        name: nameInput.value.trim(),
        phone: phoneInput.value.trim(),
        email: emailInput.value.trim(),
        service: serviceSelect.value,
        stylist: document.getElementById('stylist').value || null,
        date: dateInput.value,
        time: timeSelect.value, // ISO if our options used ISO values
        notes: notesInput.value
      };

      try {
        const res = await submitBooking(payload);
        if (res.status === 201 || res.status === 200){
          // success
          const result = await res.json();
          // clear draft
          try {
            const key = hold ? DRAFT_KEY_PREFIX + hold.token : DRAFT_KEY_PREFIX + 'anon';
            localStorage.removeItem(key);
          } catch(e){}

          // redirect to thanks (append booking ID and optional return deep link)
          const bookingId = result.booking_id || result.id || '';
          const ret = result.return_url ? `&return=${encodeURIComponent(result.return_url)}` : '';
          location.href = `thanks.html?id=${encodeURIComponent(bookingId)}${ret}`;
          return;
        } else if (res.status === 409){
          // conflict — server should return alternatives
          const body = await res.json();
          const alternatives = body.alternatives || [];
          showError('Selected time is no longer available. Suggested alternatives provided.');
          populateTimeOptions(alternatives);
          enableSubmit();
          submitText.textContent = 'Confirm booking';
          return;
        } else if (res.status === 410){
          showError('Your hold token expired. Please request a new booking link from the chat.');
          return;
        } else {
          const body = await res.text();
          showError('Booking failed. Please try again.');
          console.warn('booking failed', res.status, body);
          enableSubmit();
          submitText.textContent = 'Confirm booking';
          return;
        }
      } catch(e){
        showError('Network error while booking. Try again.');
        enableSubmit();
        submitText.textContent = 'Confirm booking';
        return;
      }
    });

    // Prevent rage-back spamming: replace state and cache initial
    history.replaceState({}, document.title, window.location.pathname);
  }

  // run init
  init();
})();
