import { supabase } from './supabase-config.js';

var currentUser = null;
var userSettings = { currency: 'USD', income: 0, savings_goal: 0 };
var expenses = [];
var savingsGoals = [];
var pieChart = null;
var barChart = null;
var savingsChart = null;
var currencyChart = null;
var trendChart = null;
var customCategories = [];
var exchangeRates = {};
var accountMode = 'personal'; // set from Supabase in initApp
var isPro = false;

// === PRO SYSTEM FLAG ===
// Set to true when ready to enable subscriptions
var ENABLE_PRO_SYSTEM = false;

// Helper: update a single user setting in memory + Supabase
async function updateUserSetting(key, value) {
    userSettings[key] = value;
    var patch = {};
    patch[key] = value;
    await supabase.from('user_settings').update(patch).eq('user_id', currentUser.id);
    auditLog('setting_updated', { key: key });
}

// Helper: update multiple user settings in memory + Supabase
async function updateUserSettings(patch) {
    Object.assign(userSettings, patch);
    await supabase.from('user_settings').update(patch).eq('user_id', currentUser.id);
    auditLog('settings_updated', { keys: Object.keys(patch) });
}

// Audit logging - records key user actions for security
async function auditLog(action, detail) {
    if (!currentUser) return;
    try {
        await supabase.from('audit_logs').insert({
            user_id: currentUser.id,
            action: action,
            detail: typeof detail === 'object' ? JSON.stringify(detail) : (detail || null),
            user_agent: navigator.userAgent
        });
    } catch (e) {
        // Silent fail - don't break app if logging fails
    }
}

// Helper: get tithe setting for current mode
function getTitheSetting() {
    return userSettings['tithe_' + accountMode] || false;
}

// One-time migration: move localStorage preferences to Supabase
async function migrateLocalStorageToSupabase() {
    if (localStorage.getItem('bw-ls-migrated')) return;

    var patch = {};

    var mode = localStorage.getItem('bw-mode');
    if (mode) patch.account_mode = mode;

    var company = localStorage.getItem('bw-company');
    if (company) patch.company_name = company;

    var bizType = localStorage.getItem('bw-biz-type');
    if (bizType) patch.biz_type = bizType;

    var famName = localStorage.getItem('bw-family-name');
    if (famName) patch.family_name = famName;

    var famBackup = localStorage.getItem('bw-family-name-backup');
    if (famBackup) patch.family_name_backup = famBackup;

    if (localStorage.getItem('bw-setup-done')) patch.setup_done = true;
    if (localStorage.getItem('bw-biz-setup-done')) patch.biz_setup_done = true;
    if (localStorage.getItem('bw-family-setup-done')) patch.family_setup_done = true;

    try {
        var limits = JSON.parse(localStorage.getItem('bw-budget-limits') || 'null');
        if (limits && Object.keys(limits).length > 0) patch.budget_limits = limits;
    } catch(e) {}

    if (localStorage.getItem('bw-tithe-personal') === '1') patch.tithe_personal = true;
    if (localStorage.getItem('bw-tithe-business') === '1') patch.tithe_business = true;
    if (localStorage.getItem('bw-tithe-family') === '1') patch.tithe_family = true;

    var avatar = localStorage.getItem('bw-avatar');
    if (avatar) patch.avatar_url = avatar;

    try {
        var wishes = JSON.parse(localStorage.getItem('bw-wishes-' + currentUser.id) || 'null');
        if (wishes && wishes.length > 0) patch.wishes = wishes;
    } catch(e) {}

    var primary = localStorage.getItem('bw-primary-account');
    if (primary) patch.primary_account = primary;

    try {
        var dismissed = JSON.parse(localStorage.getItem('bw-recurring-dismissed') || 'null');
        if (dismissed && dismissed.length > 0) patch.recurring_dismissed = dismissed;
    } catch(e) {}

    // Check if user_settings row already exists (means setup was completed)
    var existing = await supabase.from('user_settings')
        .select('id, currency').eq('user_id', currentUser.id).limit(1);
    var rowExists = existing.data && existing.data.length > 0;

    // If row exists with currency set, mark setup as done even if localStorage flag was lost
    if (rowExists && existing.data[0].currency && !patch.setup_done) {
        patch.setup_done = true;
    }

    // Migrate tour-done flags
    var tourDone = {};
    ['personal','business','family'].forEach(function(m) {
        if (localStorage.getItem('bw-tour-done-' + m)) tourDone[m] = true;
    });
    if (Object.keys(tourDone).length > 0) patch.tour_done = tourDone;

    // Migrate page hint dismissals
    var hintsDismissed = {};
    ['tracker','members','allowances','invoices','pnl','tax'].forEach(function(h) {
        if (localStorage.getItem('bw-hint-' + h)) hintsDismissed[h] = true;
    });
    if (Object.keys(hintsDismissed).length > 0) patch.hints_dismissed = hintsDismissed;

    // Migrate allowance reset week
    var arw = localStorage.getItem('bw-allowance-reset-week');
    if (arw) patch.allowance_reset_week = arw;

    // Migrate summary dismissed and budget alerts (current month only)
    var nowMig = new Date();
    var sumKey = 'bw-summary-dismissed-' + nowMig.getFullYear() + '-' + (nowMig.getMonth() + 1);
    if (localStorage.getItem(sumKey)) {
        var sd = {}; sd[nowMig.getFullYear() + '-' + (nowMig.getMonth() + 1)] = true;
        patch.summary_dismissed = sd;
    }
    var alertKeyMig = 'bw-budget-alert-' + nowMig.getFullYear() + '-' + nowMig.getMonth();
    var alertVal = localStorage.getItem(alertKeyMig);
    if (alertVal) {
        var ba = {}; ba[nowMig.getFullYear() + '-' + nowMig.getMonth()] = alertVal;
        patch.budget_alerts = ba;
    }

    // Re-check: if row exists update, otherwise insert (patch may have grown)
    if (Object.keys(patch).length > 0) {
        if (rowExists) {
            await supabase.from('user_settings').update(patch).eq('user_id', currentUser.id);
        } else {
            patch.user_id = currentUser.id;
            await supabase.from('user_settings').insert(patch);
        }
    }

    // Clean up migrated localStorage keys
    ['bw-mode','bw-company','bw-biz-type','bw-family-name','bw-family-name-backup',
     'bw-setup-done','bw-biz-setup-done','bw-family-setup-done','bw-budget-limits',
     'bw-tithe-personal','bw-tithe-business','bw-tithe-family','bw-avatar',
     'bw-wishes-' + currentUser.id,'bw-primary-account','bw-recurring-dismissed',
     'bw-allowance-reset-week', sumKey, alertKeyMig,
     'bw-tour-done-personal','bw-tour-done-business','bw-tour-done-family',
     'bw-hint-tracker','bw-hint-members','bw-hint-allowances',
     'bw-hint-invoices','bw-hint-pnl','bw-hint-tax'
    ].forEach(function(key) { localStorage.removeItem(key); });

    localStorage.setItem('bw-ls-migrated', '1');
}

// Stripe config — replace with your live keys when ready
var STRIPE_PUBLISHABLE_KEY = ''; // pk_live_... or pk_test_...
var STRIPE_PRICE_MONTHLY = ''; // price_... from Stripe dashboard
var STRIPE_PRICE_YEARLY = '';  // price_... from Stripe dashboard

var categoryColors = {
    'Housing': '#10b981',
    'Food': '#f59e0b',
    'Transport': '#3b82f6',
    'Utilities': '#8b5cf6',
    'Entertainment': '#ec4899',
    'Shopping': '#f97316',
    'Health': '#06b6d4',
    'Education': '#6366f1',
    'Subscriptions': '#14b8a6',
    'Personal': '#e879f9',
    'Savings': '#22d3ee',
    'Tithe': '#a78bfa',
    'Other': '#6b7280'
};

var goalColors = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#f97316', '#6366f1'];

// Category icons (emoji)
var categoryIcons = {
    'Housing': '\uD83C\uDFE0', 'Food': '\uD83C\uDF55', 'Transport': '\uD83D\uDE97', 'Utilities': '\u26A1',
    'Entertainment': '\uD83C\uDFAC', 'Shopping': '\uD83D\uDECD\uFE0F', 'Health': '\uD83C\uDFE5', 'Education': '\uD83C\uDF93',
    'Subscriptions': '\uD83D\uDD04', 'Personal': '\u2728', 'Savings': '\uD83D\uDCB0', 'Other': '\uD83D\uDCCC',
    'COGS': '\uD83D\uDCE6', 'Payroll': '\uD83D\uDCB5', 'Rent & Lease': '\uD83C\uDFE2', 'Marketing': '\uD83D\uDCE3',
    'Software & SaaS': '\uD83D\uDCBB', 'Professional Fees': '\u2696\uFE0F', 'Office Expenses': '\uD83D\uDCCB',
    'Travel & Mileage': '\u2708\uFE0F', 'Client Meals': '\uD83C\uDF7D\uFE0F', 'Equipment': '\uD83D\uDD27',
    'Insurance': '\uD83D\uDEE1\uFE0F', 'Taxes & Licenses': '\uD83D\uDCDC', 'Contractors': '\uD83D\uDC77',
    'Shipping & Logistics': '\uD83D\uDE9A', 'Bank & Processing Fees': '\uD83C\uDFE6', 'Miscellaneous': '\uD83D\uDCCC',
    'Groceries': '\uD83D\uDED2', 'Household Bills': '\uD83D\uDCF1', 'School Fees': '\uD83D\uDCDA',
    'Medical': '\uD83D\uDC8A', 'Clothing': '\uD83D\uDC55', 'Outings': '\uD83C\uDFA1', 'Pocket Money': '\uD83E\uDE99',
    'Gifts': '\uD83C\uDF81', 'Pets': '\uD83D\uDC3E', 'Family Savings': '\uD83C\uDFF6',
    'Tithe': '\u26EA'
};

// Undo toast system
var undoTimer = null;
function showUndoToast(message, undoFn) {
    var toast = document.getElementById('undoToast');
    if (!toast) return;
    clearTimeout(undoTimer);
    toast.querySelector('.undo-message').textContent = message;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    var undoBtn = toast.querySelector('.undo-btn');
    var newBtn = undoBtn.cloneNode(true);
    undoBtn.parentNode.replaceChild(newBtn, undoBtn);
    newBtn.addEventListener('click', function() {
        clearTimeout(undoTimer);
        toast.classList.remove('show');
        setTimeout(function() { toast.classList.add('hidden'); }, 300);
        if (undoFn) undoFn();
    });
    undoTimer = setTimeout(function() {
        toast.classList.remove('show');
        setTimeout(function() { toast.classList.add('hidden'); }, 300);
    }, 5000);
}

var currencies = [
    'ZAR','USD','EUR','GBP','NGN','KES','GHS','INR','BRL','JPY','AUD','CAD','CNY','BWP','MZN','CHF','SEK','NOK','NZD','SGD','HKD','MXN','EGP','TZS','UGX','RWF','XOF',
    'AED','AFN','ALL','AMD','ANG','AOA','ARS','AWG','AZN','BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BSD','BTN','BYN','BZD','CDF','CLP','COP','CRC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','ERN','ETB','FJD','FKP','GEL','GIP','GMD','GNF','GTQ','GYD','HNL','HRK','HTG','HUF','IDR','ILS','IQD','IRR','ISK','JMD','JOD','KGS','KHR','KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MYR','NAD','NIO','NPR','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','SAR','SBD','SCR','SDG','SHP','SLE','SOS','SRD','SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','UAH','UYU','UZS','VES','VND','VUV','WST','XAF','XCD','XPF','YER','ZMW','ZWL'
];

var currencyInfo = {
    'ZAR': { flag: '\uD83C\uDDFF\uD83C\uDDE6', name: 'South African Rand', symbol: 'R' },
    'USD': { flag: '\uD83C\uDDFA\uD83C\uDDF8', name: 'US Dollar', symbol: '$' },
    'EUR': { flag: '\uD83C\uDDEA\uD83C\uDDFA', name: 'Euro', symbol: '\u20AC' },
    'GBP': { flag: '\uD83C\uDDEC\uD83C\uDDE7', name: 'British Pound', symbol: '\u00A3' },
    'NGN': { flag: '\uD83C\uDDF3\uD83C\uDDEC', name: 'Nigerian Naira', symbol: '\u20A6' },
    'KES': { flag: '\uD83C\uDDF0\uD83C\uDDEA', name: 'Kenyan Shilling', symbol: 'KSh' },
    'GHS': { flag: '\uD83C\uDDEC\uD83C\uDDED', name: 'Ghanaian Cedi', symbol: 'GH\u20B5' },
    'INR': { flag: '\uD83C\uDDEE\uD83C\uDDF3', name: 'Indian Rupee', symbol: '\u20B9' },
    'BRL': { flag: '\uD83C\uDDE7\uD83C\uDDF7', name: 'Brazilian Real', symbol: 'R$' },
    'JPY': { flag: '\uD83C\uDDEF\uD83C\uDDF5', name: 'Japanese Yen', symbol: '\u00A5' },
    'AUD': { flag: '\uD83C\uDDE6\uD83C\uDDFA', name: 'Australian Dollar', symbol: 'A$' },
    'CAD': { flag: '\uD83C\uDDE8\uD83C\uDDE6', name: 'Canadian Dollar', symbol: 'C$' },
    'CNY': { flag: '\uD83C\uDDE8\uD83C\uDDF3', name: 'Chinese Yuan', symbol: '\u00A5' },
    'BWP': { flag: '\uD83C\uDDE7\uD83C\uDDFC', name: 'Botswana Pula', symbol: 'P' },
    'MZN': { flag: '\uD83C\uDDF2\uD83C\uDDFF', name: 'Mozambican Metical', symbol: 'MT' },
    'CHF': { flag: '\uD83C\uDDE8\uD83C\uDDED', name: 'Swiss Franc', symbol: 'CHF' },
    'SEK': { flag: '\uD83C\uDDF8\uD83C\uDDEA', name: 'Swedish Krona', symbol: 'kr' },
    'NOK': { flag: '\uD83C\uDDF3\uD83C\uDDF4', name: 'Norwegian Krone', symbol: 'kr' },
    'NZD': { flag: '\uD83C\uDDF3\uD83C\uDDFF', name: 'New Zealand Dollar', symbol: 'NZ$' },
    'SGD': { flag: '\uD83C\uDDF8\uD83C\uDDEC', name: 'Singapore Dollar', symbol: 'S$' },
    'HKD': { flag: '\uD83C\uDDED\uD83C\uDDF0', name: 'Hong Kong Dollar', symbol: 'HK$' },
    'MXN': { flag: '\uD83C\uDDF2\uD83C\uDDFD', name: 'Mexican Peso', symbol: 'Mex$' },
    'EGP': { flag: '\uD83C\uDDEA\uD83C\uDDEC', name: 'Egyptian Pound', symbol: 'E\u00A3' },
    'TZS': { flag: '\uD83C\uDDF9\uD83C\uDDFF', name: 'Tanzanian Shilling', symbol: 'TSh' },
    'UGX': { flag: '\uD83C\uDDFA\uD83C\uDDEC', name: 'Ugandan Shilling', symbol: 'USh' },
    'RWF': { flag: '\uD83C\uDDF7\uD83C\uDDFC', name: 'Rwandan Franc', symbol: 'RF' },
    'XOF': { flag: '\uD83C\uDF0D', name: 'West African CFA', symbol: 'CFA' },
    'AED': { flag: '\uD83C\uDDE6\uD83C\uDDEA', name: 'UAE Dirham', symbol: 'AED' },
    'ARS': { flag: '\uD83C\uDDE6\uD83C\uDDF7', name: 'Argentine Peso', symbol: 'AR$' },
    'BDT': { flag: '\uD83C\uDDE7\uD83C\uDDE9', name: 'Bangladeshi Taka', symbol: '\u09F3' },
    'CLP': { flag: '\uD83C\uDDE8\uD83C\uDDF1', name: 'Chilean Peso', symbol: 'CL$' },
    'COP': { flag: '\uD83C\uDDE8\uD83C\uDDF4', name: 'Colombian Peso', symbol: 'CO$' },
    'CZK': { flag: '\uD83C\uDDE8\uD83C\uDDFF', name: 'Czech Koruna', symbol: 'K\u010D' },
    'DKK': { flag: '\uD83C\uDDE9\uD83C\uDDF0', name: 'Danish Krone', symbol: 'kr' },
    'HUF': { flag: '\uD83C\uDDED\uD83C\uDDFA', name: 'Hungarian Forint', symbol: 'Ft' },
    'IDR': { flag: '\uD83C\uDDEE\uD83C\uDDE9', name: 'Indonesian Rupiah', symbol: 'Rp' },
    'ILS': { flag: '\uD83C\uDDEE\uD83C\uDDF1', name: 'Israeli Shekel', symbol: '\u20AA' },
    'KRW': { flag: '\uD83C\uDDF0\uD83C\uDDF7', name: 'South Korean Won', symbol: '\u20A9' },
    'KWD': { flag: '\uD83C\uDDF0\uD83C\uDDFC', name: 'Kuwaiti Dinar', symbol: 'KD' },
    'MYR': { flag: '\uD83C\uDDF2\uD83C\uDDFE', name: 'Malaysian Ringgit', symbol: 'RM' },
    'PEN': { flag: '\uD83C\uDDF5\uD83C\uDDEA', name: 'Peruvian Sol', symbol: 'S/' },
    'PHP': { flag: '\uD83C\uDDF5\uD83C\uDDED', name: 'Philippine Peso', symbol: '\u20B1' },
    'PKR': { flag: '\uD83C\uDDF5\uD83C\uDDF0', name: 'Pakistani Rupee', symbol: 'Rs' },
    'PLN': { flag: '\uD83C\uDDF5\uD83C\uDDF1', name: 'Polish Zloty', symbol: 'z\u0142' },
    'QAR': { flag: '\uD83C\uDDF6\uD83C\uDDE6', name: 'Qatari Riyal', symbol: 'QR' },
    'RON': { flag: '\uD83C\uDDF7\uD83C\uDDF4', name: 'Romanian Leu', symbol: 'lei' },
    'RUB': { flag: '\uD83C\uDDF7\uD83C\uDDFA', name: 'Russian Ruble', symbol: '\u20BD' },
    'SAR': { flag: '\uD83C\uDDF8\uD83C\uDDE6', name: 'Saudi Riyal', symbol: 'SR' },
    'THB': { flag: '\uD83C\uDDF9\uD83C\uDDED', name: 'Thai Baht', symbol: '\u0E3F' },
    'TRY': { flag: '\uD83C\uDDF9\uD83C\uDDF7', name: 'Turkish Lira', symbol: '\u20BA' },
    'TWD': { flag: '\uD83C\uDDF9\uD83C\uDDFC', name: 'Taiwan Dollar', symbol: 'NT$' },
    'UAH': { flag: '\uD83C\uDDFA\uD83C\uDDE6', name: 'Ukrainian Hryvnia', symbol: '\u20B4' },
    'VND': { flag: '\uD83C\uDDFB\uD83C\uDDF3', name: 'Vietnamese Dong', symbol: '\u20AB' },
    'XAF': { flag: '\uD83C\uDF0D', name: 'Central African CFA', symbol: 'FCFA' },
    'AFN': { flag: '\uD83C\uDDE6\uD83C\uDDEB', name: 'Afghan Afghani', symbol: '\u060B' },
    'ALL': { flag: '\uD83C\uDDE6\uD83C\uDDF1', name: 'Albanian Lek', symbol: 'L' },
    'AMD': { flag: '\uD83C\uDDE6\uD83C\uDDF2', name: 'Armenian Dram', symbol: '\u058F' },
    'ANG': { flag: '\uD83C\uDDF3\uD83C\uDDF1', name: 'Antillean Guilder', symbol: '\u0192' },
    'AOA': { flag: '\uD83C\uDDE6\uD83C\uDDF4', name: 'Angolan Kwanza', symbol: 'Kz' },
    'AWG': { flag: '\uD83C\uDDE6\uD83C\uDDFC', name: 'Aruban Florin', symbol: '\u0192' },
    'AZN': { flag: '\uD83C\uDDE6\uD83C\uDDFF', name: 'Azerbaijani Manat', symbol: '\u20BC' },
    'BAM': { flag: '\uD83C\uDDE7\uD83C\uDDE6', name: 'Bosnian Mark', symbol: 'KM' },
    'BBD': { flag: '\uD83C\uDDE7\uD83C\uDDE7', name: 'Barbadian Dollar', symbol: 'Bds$' },
    'BGN': { flag: '\uD83C\uDDE7\uD83C\uDDEC', name: 'Bulgarian Lev', symbol: '\u043B\u0432' },
    'BHD': { flag: '\uD83C\uDDE7\uD83C\uDDED', name: 'Bahraini Dinar', symbol: 'BD' },
    'BIF': { flag: '\uD83C\uDDE7\uD83C\uDDEE', name: 'Burundian Franc', symbol: 'FBu' },
    'BMD': { flag: '\uD83C\uDDE7\uD83C\uDDF2', name: 'Bermudian Dollar', symbol: 'BD$' },
    'BND': { flag: '\uD83C\uDDE7\uD83C\uDDF3', name: 'Brunei Dollar', symbol: 'B$' },
    'BOB': { flag: '\uD83C\uDDE7\uD83C\uDDF4', name: 'Bolivian Boliviano', symbol: 'Bs' },
    'BSD': { flag: '\uD83C\uDDE7\uD83C\uDDF8', name: 'Bahamian Dollar', symbol: 'B$' },
    'BTN': { flag: '\uD83C\uDDE7\uD83C\uDDF9', name: 'Bhutanese Ngultrum', symbol: 'Nu' },
    'BYN': { flag: '\uD83C\uDDE7\uD83C\uDDFE', name: 'Belarusian Ruble', symbol: 'Br' },
    'BZD': { flag: '\uD83C\uDDE7\uD83C\uDDFF', name: 'Belize Dollar', symbol: 'BZ$' },
    'CDF': { flag: '\uD83C\uDDE8\uD83C\uDDE9', name: 'Congolese Franc', symbol: 'FC' },
    'CRC': { flag: '\uD83C\uDDE8\uD83C\uDDF7', name: 'Costa Rican Col\u00F3n', symbol: '\u20A1' },
    'CUP': { flag: '\uD83C\uDDE8\uD83C\uDDFA', name: 'Cuban Peso', symbol: '$MN' },
    'CVE': { flag: '\uD83C\uDDE8\uD83C\uDDFB', name: 'Cape Verdean Escudo', symbol: 'Esc' },
    'DJF': { flag: '\uD83C\uDDE9\uD83C\uDDEF', name: 'Djiboutian Franc', symbol: 'Fdj' },
    'DOP': { flag: '\uD83C\uDDE9\uD83C\uDDF4', name: 'Dominican Peso', symbol: 'RD$' },
    'DZD': { flag: '\uD83C\uDDE9\uD83C\uDDFF', name: 'Algerian Dinar', symbol: 'DA' },
    'ERN': { flag: '\uD83C\uDDEA\uD83C\uDDF7', name: 'Eritrean Nakfa', symbol: 'Nfk' },
    'ETB': { flag: '\uD83C\uDDEA\uD83C\uDDF9', name: 'Ethiopian Birr', symbol: 'Br' },
    'FJD': { flag: '\uD83C\uDDEB\uD83C\uDDEF', name: 'Fijian Dollar', symbol: 'FJ$' },
    'FKP': { flag: '\uD83C\uDDEB\uD83C\uDDF0', name: 'Falkland Pound', symbol: '\u00A3' },
    'GEL': { flag: '\uD83C\uDDEC\uD83C\uDDEA', name: 'Georgian Lari', symbol: '\u20BE' },
    'GIP': { flag: '\uD83C\uDDEC\uD83C\uDDEE', name: 'Gibraltar Pound', symbol: '\u00A3' },
    'GMD': { flag: '\uD83C\uDDEC\uD83C\uDDF2', name: 'Gambian Dalasi', symbol: 'D' },
    'GNF': { flag: '\uD83C\uDDEC\uD83C\uDDF3', name: 'Guinean Franc', symbol: 'FG' },
    'GTQ': { flag: '\uD83C\uDDEC\uD83C\uDDF9', name: 'Guatemalan Quetzal', symbol: 'Q' },
    'GYD': { flag: '\uD83C\uDDEC\uD83C\uDDFE', name: 'Guyanese Dollar', symbol: 'G$' },
    'HNL': { flag: '\uD83C\uDDED\uD83C\uDDF3', name: 'Honduran Lempira', symbol: 'L' },
    'HRK': { flag: '\uD83C\uDDED\uD83C\uDDF7', name: 'Croatian Kuna', symbol: 'kn' },
    'HTG': { flag: '\uD83C\uDDED\uD83C\uDDF9', name: 'Haitian Gourde', symbol: 'G' },
    'IQD': { flag: '\uD83C\uDDEE\uD83C\uDDF6', name: 'Iraqi Dinar', symbol: 'ID' },
    'IRR': { flag: '\uD83C\uDDEE\uD83C\uDDF7', name: 'Iranian Rial', symbol: '\uFDFC' },
    'ISK': { flag: '\uD83C\uDDEE\uD83C\uDDF8', name: 'Icelandic Kr\u00F3na', symbol: 'kr' },
    'JMD': { flag: '\uD83C\uDDEF\uD83C\uDDF2', name: 'Jamaican Dollar', symbol: 'J$' },
    'JOD': { flag: '\uD83C\uDDEF\uD83C\uDDF4', name: 'Jordanian Dinar', symbol: 'JD' },
    'KGS': { flag: '\uD83C\uDDF0\uD83C\uDDEC', name: 'Kyrgyz Som', symbol: '\u043B\u0432' },
    'KHR': { flag: '\uD83C\uDDF0\uD83C\uDDED', name: 'Cambodian Riel', symbol: '\u17DB' },
    'KMF': { flag: '\uD83C\uDDF0\uD83C\uDDF2', name: 'Comorian Franc', symbol: 'CF' },
    'KPW': { flag: '\uD83C\uDDF0\uD83C\uDDF5', name: 'North Korean Won', symbol: '\u20A9' },
    'KYD': { flag: '\uD83C\uDDF0\uD83C\uDDFE', name: 'Cayman Dollar', symbol: 'CI$' },
    'KZT': { flag: '\uD83C\uDDF0\uD83C\uDDFF', name: 'Kazakh Tenge', symbol: '\u20B8' },
    'LAK': { flag: '\uD83C\uDDF1\uD83C\uDDE6', name: 'Lao Kip', symbol: '\u20AD' },
    'LBP': { flag: '\uD83C\uDDF1\uD83C\uDDE7', name: 'Lebanese Pound', symbol: 'LL' },
    'LKR': { flag: '\uD83C\uDDF1\uD83C\uDDF0', name: 'Sri Lankan Rupee', symbol: 'Rs' },
    'LRD': { flag: '\uD83C\uDDF1\uD83C\uDDF7', name: 'Liberian Dollar', symbol: 'L$' },
    'LSL': { flag: '\uD83C\uDDF1\uD83C\uDDF8', name: 'Lesotho Loti', symbol: 'L' },
    'LYD': { flag: '\uD83C\uDDF1\uD83C\uDDFE', name: 'Libyan Dinar', symbol: 'LD' },
    'MAD': { flag: '\uD83C\uDDF2\uD83C\uDDE6', name: 'Moroccan Dirham', symbol: 'MAD' },
    'MDL': { flag: '\uD83C\uDDF2\uD83C\uDDE9', name: 'Moldovan Leu', symbol: 'L' },
    'MGA': { flag: '\uD83C\uDDF2\uD83C\uDDEC', name: 'Malagasy Ariary', symbol: 'Ar' },
    'MKD': { flag: '\uD83C\uDDF2\uD83C\uDDF0', name: 'Macedonian Denar', symbol: '\u0434\u0435\u043D' },
    'MMK': { flag: '\uD83C\uDDF2\uD83C\uDDF2', name: 'Myanmar Kyat', symbol: 'K' },
    'MNT': { flag: '\uD83C\uDDF2\uD83C\uDDF3', name: 'Mongolian Tugrik', symbol: '\u20AE' },
    'MOP': { flag: '\uD83C\uDDF2\uD83C\uDDF4', name: 'Macanese Pataca', symbol: 'MOP$' },
    'MRU': { flag: '\uD83C\uDDF2\uD83C\uDDF7', name: 'Mauritanian Ouguiya', symbol: 'UM' },
    'MUR': { flag: '\uD83C\uDDF2\uD83C\uDDFA', name: 'Mauritian Rupee', symbol: 'Rs' },
    'MVR': { flag: '\uD83C\uDDF2\uD83C\uDDFB', name: 'Maldivian Rufiyaa', symbol: 'Rf' },
    'MWK': { flag: '\uD83C\uDDF2\uD83C\uDDFC', name: 'Malawian Kwacha', symbol: 'MK' },
    'NAD': { flag: '\uD83C\uDDF3\uD83C\uDDE6', name: 'Namibian Dollar', symbol: 'N$' },
    'NIO': { flag: '\uD83C\uDDF3\uD83C\uDDEE', name: 'Nicaraguan C\u00F3rdoba', symbol: 'C$' },
    'NPR': { flag: '\uD83C\uDDF3\uD83C\uDDF5', name: 'Nepalese Rupee', symbol: 'Rs' },
    'OMR': { flag: '\uD83C\uDDF4\uD83C\uDDF2', name: 'Omani Rial', symbol: 'OMR' },
    'PAB': { flag: '\uD83C\uDDF5\uD83C\uDDE6', name: 'Panamanian Balboa', symbol: 'B/' },
    'PGK': { flag: '\uD83C\uDDF5\uD83C\uDDEC', name: 'Papua New Guinean Kina', symbol: 'K' },
    'PYG': { flag: '\uD83C\uDDF5\uD83C\uDDFE', name: 'Paraguayan Guarani', symbol: '\u20B2' },
    'RSD': { flag: '\uD83C\uDDF7\uD83C\uDDF8', name: 'Serbian Dinar', symbol: 'din' },
    'SBD': { flag: '\uD83C\uDDF8\uD83C\uDDE7', name: 'Solomon Islands Dollar', symbol: 'SI$' },
    'SCR': { flag: '\uD83C\uDDF8\uD83C\uDDE8', name: 'Seychellois Rupee', symbol: 'Rs' },
    'SDG': { flag: '\uD83C\uDDF8\uD83C\uDDE9', name: 'Sudanese Pound', symbol: 'SDG' },
    'SHP': { flag: '\uD83C\uDDF8\uD83C\uDDED', name: 'Saint Helena Pound', symbol: '\u00A3' },
    'SLE': { flag: '\uD83C\uDDF8\uD83C\uDDF1', name: 'Sierra Leonean Leone', symbol: 'Le' },
    'SOS': { flag: '\uD83C\uDDF8\uD83C\uDDF4', name: 'Somali Shilling', symbol: 'Sh' },
    'SRD': { flag: '\uD83C\uDDF8\uD83C\uDDF7', name: 'Surinamese Dollar', symbol: 'Sr$' },
    'SSP': { flag: '\uD83C\uDDF8\uD83C\uDDF8', name: 'South Sudanese Pound', symbol: 'SSP' },
    'STN': { flag: '\uD83C\uDDF8\uD83C\uDDF9', name: 'S\u00E3o Tom\u00E9 Dobra', symbol: 'Db' },
    'SVC': { flag: '\uD83C\uDDF8\uD83C\uDDFB', name: 'Salvadoran Col\u00F3n', symbol: '\u20A1' },
    'SYP': { flag: '\uD83C\uDDF8\uD83C\uDDFE', name: 'Syrian Pound', symbol: 'LS' },
    'SZL': { flag: '\uD83C\uDDF8\uD83C\uDDFF', name: 'Eswatini Lilangeni', symbol: 'E' },
    'TJS': { flag: '\uD83C\uDDF9\uD83C\uDDEF', name: 'Tajik Somoni', symbol: 'SM' },
    'TMT': { flag: '\uD83C\uDDF9\uD83C\uDDF2', name: 'Turkmen Manat', symbol: 'T' },
    'TND': { flag: '\uD83C\uDDF9\uD83C\uDDF3', name: 'Tunisian Dinar', symbol: 'DT' },
    'TOP': { flag: '\uD83C\uDDF9\uD83C\uDDF4', name: 'Tongan Pa\u02BBanga', symbol: 'T$' },
    'TTD': { flag: '\uD83C\uDDF9\uD83C\uDDF9', name: 'Trinidad Dollar', symbol: 'TT$' },
    'UYU': { flag: '\uD83C\uDDFA\uD83C\uDDFE', name: 'Uruguayan Peso', symbol: '$U' },
    'UZS': { flag: '\uD83C\uDDFA\uD83C\uDDFF', name: 'Uzbek Som', symbol: 'so\u02BBm' },
    'VES': { flag: '\uD83C\uDDFB\uD83C\uDDEA', name: 'Venezuelan Bol\u00EDvar', symbol: 'Bs.S' },
    'VUV': { flag: '\uD83C\uDDFB\uD83C\uDDFA', name: 'Vanuatu Vatu', symbol: 'VT' },
    'WST': { flag: '\uD83C\uDDFC\uD83C\uDDF8', name: 'Samoan Tala', symbol: 'WS$' },
    'XCD': { flag: '\uD83C\uDF0D', name: 'East Caribbean Dollar', symbol: 'EC$' },
    'XPF': { flag: '\uD83C\uDF0D', name: 'CFP Franc', symbol: '\u20A3' },
    'YER': { flag: '\uD83C\uDDFE\uD83C\uDDEA', name: 'Yemeni Rial', symbol: 'YR' },
    'ZMW': { flag: '\uD83C\uDDFF\uD83C\uDDF2', name: 'Zambian Kwacha', symbol: 'ZK' },
    'ZWL': { flag: '\uD83C\uDDFF\uD83C\uDDFC', name: 'Zimbabwean Dollar', symbol: 'Z$' }
};

// Theme toggle
function setupTheme() {
    var saved = localStorage.getItem('bw-theme');
    if (saved === 'light') document.body.classList.add('light');
    document.documentElement.classList.remove('light-early');

    document.querySelectorAll('#themeToggleDesktop, #themeToggleMobile').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.body.classList.toggle('light');
            localStorage.setItem('bw-theme', document.body.classList.contains('light') ? 'light' : 'dark');
            // Re-render charts with new theme colors
            if (userSettings) {
                renderOverview();
                renderTrendChart();
                renderSavingsPage();
                renderCurrencyChart();
            }
        });
    });
}
setupTheme();

// PWA Install prompt
var deferredInstallPrompt = null;
var isMobile = window.matchMedia('(max-width: 768px)').matches;

window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    // Show sidebar install button
    document.getElementById('installBtn').classList.remove('hidden');
    // Show mobile banner if on mobile and not dismissed this session
    if (isMobile && !sessionStorage.getItem('bw-install-dismissed')) {
        var banner = document.getElementById('mobileInstallBanner');
        if (banner) banner.classList.remove('hidden');
    }
});

function triggerInstall() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function(result) {
        if (result.outcome === 'accepted') {
            document.getElementById('installBtn').classList.add('hidden');
            var banner = document.getElementById('mobileInstallBanner');
            if (banner) banner.classList.add('hidden');
        }
        deferredInstallPrompt = null;
    });
}

document.getElementById('installBtn').addEventListener('click', triggerInstall);

// Mobile install banner button
var installBannerBtn = document.getElementById('installBannerBtn');
if (installBannerBtn) {
    installBannerBtn.addEventListener('click', triggerInstall);
}

// Dismiss mobile install banner
var installBannerDismiss = document.getElementById('installBannerDismiss');
if (installBannerDismiss) {
    installBannerDismiss.addEventListener('click', function() {
        var banner = document.getElementById('mobileInstallBanner');
        if (banner) banner.classList.add('hidden');
        sessionStorage.setItem('bw-install-dismissed', '1');
    });
}

window.addEventListener('appinstalled', function() {
    document.getElementById('installBtn').classList.add('hidden');
    var banner = document.getElementById('mobileInstallBanner');
    if (banner) banner.classList.add('hidden');
    deferredInstallPrompt = null;
});

// iOS Safari: no beforeinstallprompt event. Show manual instructions.
var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
var isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isIOS && !isStandalone && isMobile && !sessionStorage.getItem('bw-install-dismissed')) {
    var banner = document.getElementById('mobileInstallBanner');
    var btn = document.getElementById('installBannerBtn');
    if (banner && btn) {
        btn.textContent = 'How to Install';
        btn.addEventListener('click', function() {
            alert('Tap the Share button (box with arrow) at the bottom of Safari, then tap "Add to Home Screen".');
        }, { once: true });
        banner.classList.remove('hidden');
    }
}

// Auth guard
(async function() {
    var result = await supabase.auth.getSession();
    if (!result.data.session) {
        window.location.href = 'index.html';
        return;
    }
    currentUser = result.data.session.user;
    auditLog('login', 'Session restored');
    if (['ezechiasmulamba@gmail.com'].includes(currentUser.email)) {
        var adminNav = document.getElementById('adminNavItem');
        if (adminNav) adminNav.style.display = '';
    }

    // Listen for auth state changes (token refresh, sign out, etc.)
    supabase.auth.onAuthStateChange(function(event, session) {
        if (event === 'SIGNED_OUT' || (!session && event !== 'INITIAL_SESSION')) {
            window.location.href = 'index.html';
        } else if (event === 'TOKEN_REFRESHED' && session) {
            currentUser = session.user;
        }
    });

    checkUpgradeRedirect();
    initApp();
})();

async function initApp() {
    try {
        setupUI();
        setupNav();
        setupModals();
        setupSetupForm();
        setupExpenseForm();
        setupSavingsForm();
        setupGoalForms();
        setupCurrencyConverter();
        setupSearchAndExport();
        setupReceiptScanning();
        setupCustomCategories();
        setupDrillDown();
        setupFAB();
        setupBudgetLimits();
        setupSharedBudgets();
        setupBankConnect();
        setupBusinessFeatures();
        setupFamilyFeatures();
        setupQuickAdd();
        setupGlobalSearch();
        setupSwipeActions();
        setupBudgetTemplates();
        setupEditMember();
        setupWishList();
        setupFamilyReport();
        setupHelpPage();
        setupModalAutoDismiss();
        setupFamilyTracking();
        setupNotifications();
        setupMoveAccountModal();
        setupMoveMoneyModal();
        setupTxRoutingModal();
        setupSubscription();

        // Migrate localStorage to Supabase (one-time)
        await migrateLocalStorageToSupabase();

        // Single row per user — fetch it
        var result = await supabase
            .from('user_settings')
            .select('*')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        if (result.data) {
            // Set account mode from Supabase
            accountMode = result.data.account_mode || 'personal';

            // Apply mode-specific overrides
            if (accountMode === 'business') {
                userSettings = Object.assign({}, result.data, {
                    currency: result.data.biz_currency || result.data.currency || 'USD',
                    income: result.data.biz_income || 0,
                    savings_goal: result.data.biz_savings_goal || 0
                });
            } else if (accountMode === 'family') {
                userSettings = Object.assign({}, result.data, {
                    currency: result.data.fam_currency || result.data.currency || 'USD',
                    income: result.data.fam_income || 0,
                    savings_goal: result.data.fam_savings_goal || 0
                });
            } else {
                userSettings = result.data;
            }

            // Re-apply mode now that we have the correct one from DB
            applyMode(accountMode);

            document.querySelector('.main-content').classList.add('loaded');
            setupTithe();
            loadCustomCategories();
            swapExpenseCategories(accountMode);
            await Promise.all([loadExpenses(), loadSavingsGoals(), loadCurrencyPage()]);
            checkMonthlyTithe();
            autoPopulateRecurring();
            loadLinkedAccounts();
            loadSharedGroups();
            setupSABankModal();
            loadBusinessData();
            if (accountMode === 'family') await loadFamilyData();
            detectRecurringExpenses();
            setupOnboardingTour();

            // Restore saved page after all data is loaded
            var savedPage = localStorage.getItem('bw-active-page');
            if (savedPage && savedPage !== 'overview' && document.getElementById('page-' + savedPage)) {
                var savedNav = document.querySelector('.nav-item[data-page="' + savedPage + '"]');
                if (savedNav) savedNav.click();
            }
        } else {
            // No settings at all — first time personal user, show setup
            document.querySelector('.main-content').classList.add('loaded');
            document.getElementById('setupModal').classList.remove('hidden');
        }
    } catch (err) {
        console.error('Init error:', err);
    }
    // Hide loading spinner
    var overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        setTimeout(function() { overlay.remove(); }, 400);
    }
}

function setupUI() {
    var meta = currentUser.user_metadata || {};
    var name = meta.full_name || meta.name || (currentUser.email ? currentUser.email.split('@')[0] : 'User');
    document.getElementById('userName').textContent = name;
    var sidebarAvatar = document.getElementById('userAvatar');
    var savedPic = userSettings.avatar_url;
    if (savedPic && /^https?:\/\/[^\s"');<>]+$/.test(savedPic)) {
        sidebarAvatar.textContent = '';
        sidebarAvatar.style.backgroundImage = 'url(' + encodeURI(savedPic) + ')';
        sidebarAvatar.style.backgroundSize = 'cover';
    } else {
        sidebarAvatar.textContent = name.charAt(0).toUpperCase();
    }

    // Set primary account from metadata if not stored in settings yet
    if (!userSettings.primary_account && meta.primary_account) {
        updateUserSetting('primary_account', meta.primary_account);
        // First login — set mode to primary account
        if (!userSettings.account_mode || userSettings.account_mode === 'personal') {
            accountMode = meta.primary_account;
            updateUserSetting('account_mode', meta.primary_account);
        }
        // Store company/family name from metadata
        if (meta.company_name) updateUserSetting('company_name', meta.company_name);
        if (meta.family_name) updateUserSetting('family_name', meta.family_name);
    }

    // Welcome message
    updateWelcomeGreeting();

    var now = new Date();
    document.getElementById('overviewMonth').textContent =
        now.toLocaleString('default', { month: 'long', year: 'numeric' });
    document.getElementById('expDate').value = now.toISOString().split('T')[0];

    var filter = document.getElementById('monthFilter');
    for (var i = 0; i < 6; i++) {
        var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        var opt = document.createElement('option');
        opt.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        opt.textContent = d.toLocaleString('default', { month: 'long', year: 'numeric' });
        filter.appendChild(opt);
    }
    filter.addEventListener('change', renderAllExpenses);

    document.getElementById('logoutBtn').addEventListener('click', async function() {
        await supabase.auth.signOut();
        window.location.href = 'index.html';
    });

    // Delegated click handlers for empty-state buttons (replacing inline onclick)
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('trigger-add-expense')) { var b = document.getElementById('addExpenseBtn'); if (b) b.click(); }
        if (e.target.classList.contains('trigger-add-goal')) { var b2 = document.getElementById('addGoalBtn'); if (b2) b2.click(); }
        if (e.target.classList.contains('trigger-add-invoice')) { var b3 = document.getElementById('addInvoiceBtn'); if (b3) b3.click(); }
        if (e.target.classList.contains('trigger-add-client')) { var b4 = document.getElementById('addClientBtn'); if (b4) b4.click(); }
    });

    // Mode dropdown
    applyMode(accountMode);

    // Reorder dropdown so primary account is on top
    var primaryAccount = userSettings.primary_account;
    var dropdownMenu = document.getElementById('modeDropdownMenu');
    if (primaryAccount && dropdownMenu) {
        var primaryBtn = dropdownMenu.querySelector('.mode-option[data-mode="' + primaryAccount + '"]');
        if (primaryBtn && primaryBtn !== dropdownMenu.firstElementChild) {
            dropdownMenu.insertBefore(primaryBtn, dropdownMenu.firstElementChild);
        }
    }

    var dropdownBtn = document.getElementById('modeDropdownBtn');
    var dropdown = document.getElementById('modeDropdown');

    dropdownBtn.addEventListener('click', function() {
        dropdown.classList.toggle('open');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
        if (!dropdown.contains(e.target)) {
            dropdown.classList.remove('open');
        }
    });

    dropdownMenu.addEventListener('click', async function(e) {
        var btn = e.target.closest('.mode-option');
        if (!btn || btn.classList.contains('active')) return;
        dropdown.classList.remove('open');
        var mode = btn.dataset.mode;

        // If switching to business, check if business has been set up
        if (mode === 'business' && !userSettings.biz_setup_done) {
            var check = await supabase
                .from('user_settings')
                .select('biz_currency')
                .eq('user_id', currentUser.id)
                .maybeSingle();

            if (!check.data || !check.data.biz_currency) {
                showBusinessSetupModal();
                return;
            }
            updateUserSetting('biz_setup_done', true);
        }

        // If switching to family, check if family has been set up
        if (mode === 'family' && !userSettings.family_setup_done) {
            showFamilySetupModal();
            return;
        }

        switchMode(mode);
    });

    // Business setup form
    document.getElementById('businessSetupForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var bizUpdate = {
            biz_currency: document.getElementById('bizCurrency').value,
            biz_income: parseFloat(document.getElementById('bizIncome').value),
            biz_savings_goal: parseFloat(document.getElementById('bizGoal').value)
        };
        await supabase.from('user_settings').update(bizUpdate).eq('user_id', currentUser.id);

        await updateUserSettings({
            company_name: document.getElementById('bizName').value,
            biz_type: document.getElementById('bizType').value,
            biz_setup_done: true
        });

        document.getElementById('businessSetupModal').classList.add('hidden');
        switchMode('business');
    });

    document.getElementById('bizCancelBtn').addEventListener('click', function() {
        document.getElementById('businessSetupModal').classList.add('hidden');
    });
}

function showBusinessSetupModal() {
    var modal = document.getElementById('businessSetupModal');
    var savedCompany = userSettings.company_name;
    if (savedCompany) document.getElementById('bizName').value = savedCompany;
    // Auto-detect currency for business too
    var personalCurrency = userSettings.currency || 'USD';
    var bizCurrencyEl = document.getElementById('bizCurrency');
    for (var i = 0; i < bizCurrencyEl.options.length; i++) {
        if (bizCurrencyEl.options[i].value === personalCurrency) {
            bizCurrencyEl.selectedIndex = i;
            break;
        }
    }
    modal.classList.remove('hidden');
}

function updateWelcomeGreeting() {
    var meta = currentUser.user_metadata || {};
    var userName = meta.full_name || meta.name || (currentUser.email ? currentUser.email.split('@')[0] : 'User');
    var firstName = userName.split(' ')[0];
    var hour = new Date().getHours();
    var greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    var displayName, subs;
    var mode = accountMode;

    if (mode === 'business') {
        var companyName = userSettings.company_name;
        displayName = companyName || firstName;
        if (companyName) {
            subs = [
                'Here\'s your business overview for ' + companyName,
                companyName + '\'s finances at a glance',
                'Let\'s review ' + companyName + '\'s performance',
                'Track ' + companyName + '\'s progress'
            ];
        } else {
            subs = ['Here\'s your business overview', 'Track your business performance', 'Your company finances at a glance', 'Let\'s review your business'];
        }
    } else if (mode === 'family') {
        var familyName = userSettings.family_name;
        displayName = familyName || (firstName + '\'s Family');
        if (familyName) {
            var possessive = familyName.endsWith('s') ? familyName + '\'' : familyName + '\'s';
            subs = [
                'Here\'s the ' + familyName + ' spending overview',
                possessive + ' budget at a glance',
                'Let\'s check how ' + familyName + ' is doing',
                possessive + ' family finances'
            ];
        } else {
            subs = ['Here\'s your family spending overview', 'Let\'s check the household budget', 'Your family finances at a glance', 'See how the family is doing'];
        }
    } else {
        displayName = firstName;
        subs = ['Here\'s your financial snapshot', 'Let\'s check how you\'re doing', 'Time to track your money', 'Your budget overview awaits'];
    }

    document.getElementById('welcomeMsg').textContent = greeting + ', ' + displayName + '!';
    document.getElementById('welcomeSub').textContent = subs[Math.floor(Math.random() * subs.length)];
}

async function switchMode(mode) {
    // Business & Family modes require Pro
    if (mode !== 'personal' && !isPro && ENABLE_PRO_SYSTEM) {
        if (!requirePro('Business & Family modes')) return;
    }
    var overlay = document.getElementById('modeTransition');
    var icon = document.getElementById('modeTransitionIcon');
    var label = document.getElementById('modeTransitionLabel');

    // Set transition content
    icon.className = 'mode-transition-icon ' + mode;
    if (mode === 'business') {
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M3 21h18M9 8h1m4 0h1M9 12h1m4 0h1M9 16h1m4 0h1M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16"/></svg>';
        label.textContent = 'Switching to Business';
    } else if (mode === 'family') {
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87m-4-12a4 4 0 010 7.75"/></svg>';
        label.textContent = 'Switching to Family';
    } else {
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
        label.textContent = 'Switching to Personal';
    }

    // Show transition
    overlay.classList.add('active');

    // Navigate back to overview
    document.querySelectorAll('.nav-item').forEach(function(i) { i.classList.remove('active'); });
    var overviewNav = document.querySelector('.nav-item[data-page="overview"]');
    if (overviewNav) overviewNav.classList.add('active');
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    document.getElementById('page-overview').classList.add('active');
    var fab = document.getElementById('fabAdd');
    if (fab) fab.style.display = '';

    accountMode = mode;
    updateUserSetting('account_mode', mode);
    applyMode(mode);
    updateWelcomeGreeting();

    // Load data then hide transition — with hard 1.5s max
    try {
        await Promise.race([
            reloadDataForMode(),
            new Promise(function(resolve) { setTimeout(resolve, 1500); })
        ]);
    } catch(e) {
        console.warn('Mode switch data load error:', e);
    }

    // Brief pause for visual feedback then hide
    setTimeout(function() {
        overlay.classList.remove('active');
    }, 300);
}

function applyMode(mode) {
    // Update dropdown
    document.querySelectorAll('.mode-option').forEach(function(b) { b.classList.remove('active'); });
    var activeOpt = document.querySelector('.mode-option[data-mode="' + mode + '"]');
    if (activeOpt) activeOpt.classList.add('active');

    // Update dropdown button label and icon
    var label = document.getElementById('modeDropdownLabel');
    var iconPersonal = document.querySelector('.mode-icon-personal');
    var iconBusiness = document.querySelector('.mode-icon-business');
    var iconFamily = document.querySelector('.mode-icon-family');
    if (iconPersonal) iconPersonal.style.display = 'none';
    if (iconBusiness) iconBusiness.style.display = 'none';
    if (iconFamily) iconFamily.style.display = 'none';
    if (mode === 'business') {
        if (label) label.textContent = userSettings.company_name || 'Business';
        if (iconBusiness) iconBusiness.style.display = '';
    } else if (mode === 'family') {
        if (label) label.textContent = userSettings.family_name || 'Family';
        if (iconFamily) iconFamily.style.display = '';
    } else {
        if (label) label.textContent = 'Personal';
        if (iconPersonal) iconPersonal.style.display = '';
    }

    // Switch nav labels (preserve BETA badges)
    document.querySelectorAll('.nav-label').forEach(function(lbl) {
        var text;
        if (mode === 'business') text = lbl.dataset.business;
        else if (mode === 'family') text = lbl.dataset.family || lbl.dataset.personal;
        else text = lbl.dataset.personal;
        if (text) {
            var badge = lbl.querySelector('.beta-badge');
            lbl.textContent = text;
            if (badge) lbl.appendChild(document.createTextNode(' ')), lbl.appendChild(badge);
        }
    });

    // Show/hide mode-specific nav items
    document.querySelectorAll('.nav-personal-only').forEach(function(el) {
        el.style.display = mode === 'personal' ? '' : 'none';
    });
    document.querySelectorAll('.nav-business-only').forEach(function(el) {
        el.style.display = mode === 'business' ? '' : 'none';
    });
    document.querySelectorAll('.nav-family-only').forEach(function(el) {
        el.style.display = mode === 'family' ? '' : 'none';
    });
    // Hide items excluded from specific modes
    document.querySelectorAll('.nav-no-business').forEach(function(el) {
        el.style.display = mode === 'business' ? 'none' : '';
    });
    document.querySelectorAll('.nav-no-family').forEach(function(el) {
        el.style.display = mode === 'family' ? 'none' : '';
    });

    // Update help page sections for current mode
    document.querySelectorAll('.help-business-only').forEach(function(s) {
        s.style.display = mode === 'business' ? '' : 'none';
    });
    document.querySelectorAll('.help-family-only').forEach(function(s) {
        s.style.display = mode === 'family' ? '' : 'none';
    });

    document.body.classList.remove('business-mode', 'family-mode');
    if (mode === 'business') {
        document.body.classList.add('business-mode');
        document.querySelector('.sidebar-brand span').textContent = userSettings.company_name || 'BudgetWise Pro';
        updateLabelsForBusiness();
    } else if (mode === 'family') {
        document.body.classList.add('family-mode');
        document.querySelector('.sidebar-brand span').textContent = userSettings.family_name || 'BudgetWise Family';
        updateLabelsForFamily();
    } else {
        document.querySelector('.sidebar-brand span').textContent = 'BudgetWise';
        updateLabelsForPersonal();
    }
}

function updateLabelsForBusiness() {
    var incomeLabel = document.getElementById('statIncome');
    if (incomeLabel) incomeLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Monthly Revenue';
    var goalLabel = document.getElementById('statSaved');
    if (goalLabel) goalLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Saved This Month';
    var spentLabel = document.getElementById('statSpent');
    if (spentLabel) spentLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Total Expenses';
    var remainLabel = document.getElementById('statRemaining');
    if (remainLabel) remainLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Balance';
    var savingsHeader = document.querySelector('#page-savings .page-header h1');
    if (savingsHeader) savingsHeader.textContent = 'Budget Targets';
    var savingsSubtitle = document.querySelector('#page-savings .page-subtitle');
    if (savingsSubtitle) savingsSubtitle.textContent = 'Track your business budget targets';
    var expHeader = document.querySelector('#page-expenses .page-header h1');
    if (expHeader) expHeader.textContent = 'Business Expenses';
    var expSubtitle = document.querySelector('#page-expenses .page-subtitle');
    if (expSubtitle) expSubtitle.textContent = 'All business transactions';
    // Overview chart titles
    var pieTitle = document.querySelector('#page-overview .charts-grid .chart-card:first-child h3');
    if (pieTitle) pieTitle.textContent = 'Expenses by Category';
    var barTitle = document.querySelector('#page-overview .charts-grid .chart-card:last-child h3');
    if (barTitle) barTitle.textContent = 'Revenue vs Expenses';
    var savingsProgressTitle = document.getElementById('savingsProgressTitle');
    if (savingsProgressTitle) savingsProgressTitle.textContent = 'Budget Target Progress';
}

function updateLabelsForPersonal() {
    var incomeLabel = document.getElementById('statIncome');
    if (incomeLabel) incomeLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Monthly Income';
    var goalLabel = document.getElementById('statSaved');
    if (goalLabel) goalLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Saved This Month';
    var spentLabel = document.getElementById('statSpent');
    if (spentLabel) spentLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Total Spent';
    var remainLabel = document.getElementById('statRemaining');
    if (remainLabel) remainLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Balance';
    var savingsHeader = document.querySelector('#page-savings .page-header h1');
    if (savingsHeader) savingsHeader.textContent = 'Savings';
    var savingsSubtitle = document.querySelector('#page-savings .page-subtitle');
    if (savingsSubtitle) savingsSubtitle.textContent = 'Track your savings goals';
    var expHeader = document.querySelector('#page-expenses .page-header h1');
    if (expHeader) expHeader.textContent = 'Expenses';
    var expSubtitle = document.querySelector('#page-expenses .page-subtitle');
    if (expSubtitle) expSubtitle.textContent = 'All your transactions';
    var pieTitle = document.querySelector('#page-overview .charts-grid .chart-card:first-child h3');
    if (pieTitle) pieTitle.textContent = 'Spending by Category';
    var barTitle = document.querySelector('#page-overview .charts-grid .chart-card:last-child h3');
    if (barTitle) barTitle.textContent = 'Income vs Expenses';
    var savingsProgressTitle = document.getElementById('savingsProgressTitle');
    if (savingsProgressTitle) savingsProgressTitle.textContent = 'Savings Goal Progress';
}

function updateLabelsForFamily() {
    var incomeLabel = document.getElementById('statIncome');
    if (incomeLabel) incomeLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Household Budget';
    var goalLabel = document.getElementById('statSaved');
    if (goalLabel) goalLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Family Saved';
    var spentLabel = document.getElementById('statSpent');
    if (spentLabel) spentLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Family Spent';
    var remainLabel = document.getElementById('statRemaining');
    if (remainLabel) remainLabel.closest('.stat-card').querySelector('.stat-label').textContent = 'Budget Left';
    var savingsHeader = document.querySelector('#page-savings .page-header h1');
    if (savingsHeader) savingsHeader.textContent = 'Family Savings';
    var savingsSubtitle = document.querySelector('#page-savings .page-subtitle');
    if (savingsSubtitle) savingsSubtitle.textContent = 'Track household savings';
    var expHeader = document.querySelector('#page-expenses .page-header h1');
    if (expHeader) expHeader.textContent = 'Household Expenses';
    var expSubtitle = document.querySelector('#page-expenses .page-subtitle');
    if (expSubtitle) expSubtitle.textContent = 'All family spending';
    var pieTitle = document.querySelector('#page-overview .charts-grid .chart-card:first-child h3');
    if (pieTitle) pieTitle.textContent = 'Family Spending by Category';
    var barTitle = document.querySelector('#page-overview .charts-grid .chart-card:last-child h3');
    if (barTitle) barTitle.textContent = 'Budget vs Expenses';
    var savingsProgressTitle = document.getElementById('savingsProgressTitle');
    if (savingsProgressTitle) savingsProgressTitle.textContent = 'Family Goal Progress';
}

// ── Family Features ──
var familyMembers = [];
var familyChores = [];
var familyGoals = [];
var activeGroupId = null;  // set when user is in a family group
var myFamilyRole = null;   // 'owner', 'parent', or 'kid'
var familyLinkMembers = []; // all approved links in the group

// Resolve the user's active family group and role
async function resolveActiveGroup() {
    try {
        // Check if user owns a group
        var ownedResult = await supabase.from('family_groups')
            .select('*').eq('owner_id', currentUser.id).order('created_at', { ascending: false }).limit(1);
        if (ownedResult.data && ownedResult.data.length > 0) {
            activeGroupId = ownedResult.data[0].id;
            myFamilyRole = 'owner';
            familyGroup = ownedResult.data[0];
            return;
        }
        // Check if user is linked as a member
        var linkResult = await supabase.from('family_links')
            .select('*').eq('user_id', currentUser.id).eq('approved', true).order('joined_at', { ascending: false }).limit(1);
        if (linkResult.data && linkResult.data.length > 0) {
            activeGroupId = linkResult.data[0].group_id;
            myFamilyRole = linkResult.data[0].role || 'kid';
            familyLink = linkResult.data[0];
            return;
        }
        activeGroupId = null;
        myFamilyRole = null;
    } catch(e) {
        console.warn('resolveActiveGroup error:', e);
    }
}

function showFamilySetupModal() {
    var modal = document.getElementById('familySetupModal');
    var personalCurrency = userSettings.currency || 'USD';
    var famCurrencyEl = document.getElementById('familyCurrency');
    for (var i = 0; i < famCurrencyEl.options.length; i++) {
        if (famCurrencyEl.options[i].value === personalCurrency) {
            famCurrencyEl.selectedIndex = i;
            break;
        }
    }
    modal.classList.remove('hidden');
}

function setupFamilyFeatures() {
    // Family setup form
    document.getElementById('familySetupForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var famUpdate = {
            fam_currency: document.getElementById('familyCurrency').value,
            fam_income: parseFloat(document.getElementById('familyBudget').value),
            fam_savings_goal: 0
        };
        famUpdate.family_name = document.getElementById('familyName').value;
        famUpdate.family_setup_done = true;
        await supabase.from('user_settings').update(famUpdate).eq('user_id', currentUser.id);
        Object.assign(userSettings, famUpdate);
        document.getElementById('familySetupModal').classList.add('hidden');
        switchMode('family');
    });

    document.getElementById('familyCancelBtn').addEventListener('click', function() {
        document.getElementById('familySetupModal').classList.add('hidden');
    });

    // Add member modal
    document.getElementById('addMemberBtn').addEventListener('click', function() {
        document.getElementById('memberModal').classList.remove('hidden');
    });
    document.getElementById('closeMemberModal').addEventListener('click', function() {
        document.getElementById('memberModal').classList.add('hidden');
    });

    // Color picker
    document.getElementById('memberColorPicker').addEventListener('click', function(e) {
        var dot = e.target.closest('.color-dot');
        if (!dot) return;
        document.querySelectorAll('#memberColorPicker .color-dot').forEach(function(d) { d.classList.remove('active'); });
        dot.classList.add('active');
    });

    // Member form
    document.getElementById('memberForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var activeDot = document.querySelector('#memberColorPicker .color-dot.active');
        var member = {
            user_id: currentUser.id,
            name: document.getElementById('memberName').value.trim(),
            role: document.getElementById('memberRole').value.toLowerCase(),
            age: document.getElementById('memberAge').value || null,
            color: activeDot ? activeDot.dataset.color : '#8b5cf6',
            allowance: parseFloat(document.getElementById('memberAllowance').value) || 0,
            spent: 0,
            earned: 0
        };
        if (activeGroupId) member.group_id = activeGroupId;
        if (myFamilyRole === 'kid') {
            await supabase.from('family_pending').insert({
                group_id: activeGroupId, requested_by: currentUser.id,
                requester_name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Member',
                action: 'add_member', payload: member
            });
            showUndoToast('Member submitted for parent approval');
            notifyPendingSubmitted('add_member', 'New member: ' + member.name);
            document.getElementById('memberForm').reset();
            document.getElementById('memberModal').classList.add('hidden');
            return;
        }
        var result = await supabase.from('family_members').insert(member).select().single();
        if (result.data) familyMembers.push(result.data);
        renderMembers();
        renderAllowances();
        updateChoreAssignees();
        document.getElementById('memberForm').reset();
        document.getElementById('memberModal').classList.add('hidden');
    });

    // Add chore modal
    document.getElementById('addChoreBtn').addEventListener('click', function() {
        updateChoreAssignees();
        document.getElementById('choreModal').classList.remove('hidden');
    });
    document.getElementById('closeChoreModal').addEventListener('click', function() {
        document.getElementById('choreModal').classList.add('hidden');
    });

    // Chore form
    document.getElementById('choreForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var assigneeVal = document.getElementById('choreAssignee').value;
        var chore = {
            user_id: currentUser.id,
            name: document.getElementById('choreName').value.trim(),
            assignee: assigneeVal || null,
            reward: parseFloat(document.getElementById('choreReward').value),
            frequency: document.getElementById('choreFrequency').value,
            completed: false
        };
        if (activeGroupId) chore.group_id = activeGroupId;
        if (myFamilyRole === 'kid') {
            await supabase.from('family_pending').insert({
                group_id: activeGroupId, requested_by: currentUser.id,
                requester_name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Member',
                action: 'add_chore', payload: chore
            });
            showUndoToast('Chore submitted for parent approval');
            notifyPendingSubmitted('add_chore', 'New chore request');
            document.getElementById('choreForm').reset();
            document.getElementById('choreModal').classList.add('hidden');
            return;
        }
        var result = await supabase.from('family_chores').insert(chore).select().single();
        if (result.data) familyChores.push(result.data);
        renderChores();
        document.getElementById('choreForm').reset();
        document.getElementById('choreModal').classList.add('hidden');
    });

    // Add family goal modal
    document.getElementById('addFamilyGoalBtn').addEventListener('click', function() {
        document.getElementById('familyGoalModal').classList.remove('hidden');
    });
    document.getElementById('closeFamilyGoalModal').addEventListener('click', function() {
        document.getElementById('familyGoalModal').classList.add('hidden');
    });

    // Family goal form
    document.getElementById('familyGoalForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var goal = {
            user_id: currentUser.id,
            name: document.getElementById('familyGoalName').value.trim(),
            target: parseFloat(document.getElementById('familyGoalTarget').value),
            saved: 0,
            deadline: document.getElementById('familyGoalDeadline').value || null
        };
        if (activeGroupId) goal.group_id = activeGroupId;
        if (myFamilyRole === 'kid') {
            await supabase.from('family_pending').insert({
                group_id: activeGroupId, requested_by: currentUser.id,
                requester_name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Member',
                action: 'add_goal', payload: goal
            });
            showUndoToast('Goal submitted for parent approval');
            notifyPendingSubmitted('add_goal', 'New goal request');
            document.getElementById('familyGoalForm').reset();
            document.getElementById('familyGoalModal').classList.add('hidden');
            return;
        }
        var result = await supabase.from('family_goals').insert(goal).select().single();
        if (result.data) {
            result.data.contributions = {};
            familyGoals.push(result.data);
        }
        renderFamilyGoals();
        document.getElementById('familyGoalForm').reset();
        document.getElementById('familyGoalModal').classList.add('hidden');
    });
}

async function migrateFamilyDataToSupabase() {
    var raw = localStorage.getItem('bw-family-data-' + currentUser.id);
    if (!raw) return;
    try {
        var data = JSON.parse(raw);
        if (!data.members || data.members.length === 0) {
            localStorage.removeItem('bw-family-data-' + currentUser.id);
            return;
        }
        // Check if already migrated
        var check = await supabase.from('family_members').select('id').eq('user_id', currentUser.id).limit(1);
        if (check.data && check.data.length > 0) {
            localStorage.removeItem('bw-family-data-' + currentUser.id);
            return;
        }
        var oldToNewId = {};
        for (var i = 0; i < data.members.length; i++) {
            var m = data.members[i];
            var r = await supabase.from('family_members').insert({
                user_id: currentUser.id, name: m.name, role: (m.role || 'parent').toLowerCase(),
                age: m.age || null, color: m.color || '#8b5cf6',
                allowance: m.allowance || 0, spent: m.spent || 0, earned: m.earned || 0
            }).select().single();
            if (r.data) oldToNewId[m.id] = r.data.id;
        }
        for (var j = 0; j < (data.chores || []).length; j++) {
            var ch = data.chores[j];
            await supabase.from('family_chores').insert({
                user_id: currentUser.id, name: ch.name,
                assignee: oldToNewId[ch.assignee] || null,
                reward: ch.reward || 0, frequency: ch.frequency || 'weekly',
                completed: ch.completed || false
            });
        }
        for (var k = 0; k < (data.goals || []).length; k++) {
            var g = data.goals[k];
            var gr = await supabase.from('family_goals').insert({
                user_id: currentUser.id, name: g.name, target: g.target || 0,
                saved: g.saved || 0, deadline: g.deadline || null
            }).select().single();
            if (gr.data && g.contributions) {
                for (var memId in g.contributions) {
                    if (oldToNewId[memId]) {
                        await supabase.from('family_goal_contributions').insert({
                            goal_id: gr.data.id, member_id: oldToNewId[memId],
                            amount: g.contributions[memId]
                        });
                    }
                }
            }
        }
        localStorage.removeItem('bw-family-data-' + currentUser.id);
    } catch(e) {
        console.error('Family data migration error:', e);
    }
}

async function loadFamilyData() {
    try {
        await migrateFamilyDataToSupabase();
        var membersResult, choresResult, goalsResult;
        if (activeGroupId) {
            // Shared mode: load group data
            membersResult = await supabase.from('family_members')
                .select('*').eq('group_id', activeGroupId).order('created_at');
            choresResult = await supabase.from('family_chores')
                .select('*').eq('group_id', activeGroupId).order('created_at');
            goalsResult = await supabase.from('family_goals')
                .select('*').eq('group_id', activeGroupId).order('created_at');
        } else {
            // Solo mode (no group yet)
            membersResult = await supabase.from('family_members')
                .select('*').eq('user_id', currentUser.id).order('created_at');
            choresResult = await supabase.from('family_chores')
                .select('*').eq('user_id', currentUser.id).order('created_at');
            goalsResult = await supabase.from('family_goals')
                .select('*').eq('user_id', currentUser.id).order('created_at');
        }
        familyMembers = membersResult.data || [];
        familyChores = choresResult.data || [];
        familyGoals = goalsResult.data || [];
        // Load contributions for goals
        if (familyGoals.length > 0) {
            var goalIds = familyGoals.map(function(g) { return g.id; });
            var contribResult = await supabase.from('family_goal_contributions')
                .select('*').in('goal_id', goalIds);
            var contribs = contribResult.data || [];
            familyGoals.forEach(function(g) {
                g.contributions = {};
                contribs.forEach(function(c) {
                    if (c.goal_id === g.id) {
                        g.contributions[c.member_id] = (g.contributions[c.member_id] || 0) + Number(c.amount);
                    }
                });
            });
        }
    } catch(e) {
        console.error('Load family data error:', e);
        familyMembers = [];
        familyChores = [];
        familyGoals = [];
    }
    renderMembers();
    renderAllowances();
    renderChores();
    renderFamilyGoals();
    checkAllowanceReset();
    showFinancialTip();
    renderAllowanceWarnings();
    renderFamilyOverview();
    renderLeaderboard();
}

function renderMembers() {
    var grid = document.getElementById('membersGrid');
    var empty = document.getElementById('emptyMembers');
    if (!grid) return;
    grid.querySelectorAll('.member-card').forEach(function(c) { c.remove(); });
    if (familyMembers.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    familyMembers.forEach(function(m) {
        var card = document.createElement('div');
        card.className = 'member-card';
        var roleClass = 'role-' + m.role;
        var roleLabel = m.role.charAt(0).toUpperCase() + m.role.slice(1);
        if (m.age) roleLabel += ', ' + m.age;
        var sym = getCurrencySymbol();
        card.innerHTML =
            '<div class="member-card-header">' +
                '<div class="member-avatar" style="background:' + (/^#[0-9a-fA-F]{3,8}$/.test(m.color) ? m.color : '#6b7280') + ';">' + escapeHtml(m.name).charAt(0).toUpperCase() + '</div>' +
                '<div class="member-info">' +
                    '<h4>' + escapeHtml(m.name) + '</h4>' +
                    '<span class="member-role ' + roleClass + '">' + roleLabel + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="member-stats">' +
                '<div class="member-stat"><span class="member-stat-val">' + sym + Number(m.allowance).toFixed(2) + '</span><span class="member-stat-lbl">Allowance/wk</span></div>' +
                '<div class="member-stat"><span class="member-stat-val">' + sym + Number(m.spent || 0).toFixed(2) + '</span><span class="member-stat-lbl">Spent</span></div>' +
            '</div>' +
            '<div class="member-actions">' +
                '<button class="btn-edit-member" data-id="' + m.id + '">Edit</button>' +
                '<button class="btn-remove" data-id="' + m.id + '">Remove</button>' +
            '</div>';
        grid.appendChild(card);
    });

    // Edit member handler
    grid.querySelectorAll('.btn-edit-member').forEach(function(btn) {
        btn.addEventListener('click', function() {
            openEditMember(btn.dataset.id);
        });
    });

    // Remove member handler
    grid.querySelectorAll('.btn-remove').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            if (!confirm('Remove this family member?')) return;
            await supabase.from('family_members').delete().eq('id', btn.dataset.id);
            familyMembers = familyMembers.filter(function(m) { return m.id !== btn.dataset.id; });
            renderMembers();
            renderAllowances();
            renderChores();
        });
    });
}

function getCurrencySymbol() {
    var sym = { ZAR: 'R', USD: '$', EUR: '\u20AC', GBP: '\u00A3', NGN: '\u20A6', KES: 'KSh', GHS: 'GH\u20B5', INR: '\u20B9', BRL: 'R$', JPY: '\u00A5', AUD: 'A$', CAD: 'C$' };
    return sym[userSettings.currency] || userSettings.currency + ' ';
}

function renderAllowances() {
    var container = document.getElementById('allowanceCards');
    var empty = document.getElementById('emptyAllowances');
    if (!container) return;
    container.querySelectorAll('.allowance-card').forEach(function(c) { c.remove(); });
    var membersWithAllowance = familyMembers.filter(function(m) { return m.allowance > 0; });
    if (membersWithAllowance.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    var sym = getCurrencySymbol();
    membersWithAllowance.forEach(function(m) {
        var remaining = Math.max(0, m.allowance - (m.spent || 0));
        var pct = m.allowance > 0 ? Math.min(100, ((m.spent || 0) / m.allowance) * 100) : 0;
        var barColor = pct > 80 ? '#ef4444' : (pct > 50 ? '#f59e0b' : m.color);

        var card = document.createElement('div');
        card.className = 'allowance-card';
        card.innerHTML =
            '<div class="allowance-header">' +
                '<div class="allowance-header-left">' +
                    '<div class="allowance-mini-avatar" style="background:' + m.color + ';">' + m.name.charAt(0).toUpperCase() + '</div>' +
                    '<div><div class="allowance-name">' + escapeHtml(m.name) + '</div><div class="allowance-amount">' + sym + Number(m.allowance).toFixed(2) + '/week</div></div>' +
                '</div>' +
            '</div>' +
            '<div class="allowance-progress">' +
                '<div class="allowance-bar-track"><div class="allowance-bar-fill" style="width:' + pct + '%;background:' + barColor + ';"></div></div>' +
                '<div class="allowance-bar-labels"><span class="allowance-spent">' + sym + Number(m.spent || 0).toFixed(2) + ' spent</span><span>' + sym + remaining.toFixed(2) + ' left</span></div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
                '<button class="btn-primary btn-log-spend" data-id="' + m.id + '" style="flex:1;padding:8px;font-size:0.8rem;">Log Spending</button>' +
                '<button class="btn-primary btn-reset-allowance" data-id="' + m.id + '" style="flex:1;padding:8px;font-size:0.8rem;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.6);">Reset</button>' +
            '</div>';
        container.appendChild(card);
    });

    // Log spending
    container.querySelectorAll('.btn-log-spend').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            var amount = prompt('How much was spent?');
            if (!amount || isNaN(parseFloat(amount))) return;
            var member = familyMembers.find(function(m) { return m.id === btn.dataset.id; });
            if (member) {
                member.spent = (member.spent || 0) + parseFloat(amount);
                var spendResult = await supabase.from('family_members').update({ spent: member.spent }).eq('id', member.id);
                if (spendResult.error) { showUndoToast('Error saving spending'); console.error(spendResult.error); }
                renderAllowances();
                renderMembers();
            }
        });
    });

    // Reset allowance
    container.querySelectorAll('.btn-reset-allowance').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            if (!confirm('Reset this allowance to 0 spent?')) return;
            var member = familyMembers.find(function(m) { return m.id === btn.dataset.id; });
            if (member) {
                member.spent = 0;
                member.earned = 0;
                var resetResult = await supabase.from('family_members').update({ spent: 0, earned: 0 }).eq('id', member.id);
                if (resetResult.error) { showUndoToast('Error resetting allowance'); console.error(resetResult.error); }
                renderAllowances();
                renderMembers();
            }
        });
    });
}

function updateChoreAssignees() {
    var sel = document.getElementById('choreAssignee');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select member...</option>';
    familyMembers.forEach(function(m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        sel.appendChild(opt);
    });
}

function renderChores() {
    var list = document.getElementById('choresList');
    var empty = document.getElementById('emptyChores');
    if (!list) return;
    list.querySelectorAll('.chore-card').forEach(function(c) { c.remove(); });
    if (familyChores.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    var sym = getCurrencySymbol();
    familyChores.forEach(function(ch) {
        var member = familyMembers.find(function(m) { return m.id === ch.assignee; });
        var memberName = member ? member.name : 'Unassigned';
        var card = document.createElement('div');
        card.className = 'chore-card' + (ch.completed ? ' completed' : '');
        card.innerHTML =
            '<div class="chore-check" data-id="' + ch.id + '"></div>' +
            '<div class="chore-details">' +
                '<div class="chore-name">' + escapeHtml(ch.name) + '</div>' +
                '<div class="chore-meta">' + memberName + ' &bull; ' + ch.frequency + '</div>' +
            '</div>' +
            '<div class="chore-reward">+' + sym + Number(ch.reward).toFixed(2) + '</div>' +
            '<div class="chore-actions"><button data-id="' + ch.id + '" title="Delete">&times;</button></div>';
        list.appendChild(card);
    });

    // Complete chore
    list.querySelectorAll('.chore-check').forEach(function(check) {
        check.addEventListener('click', async function() {
            var chore = familyChores.find(function(c) { return c.id === check.dataset.id; });
            if (!chore) return;
            chore.completed = !chore.completed;
            var choreResult = await supabase.from('family_chores').update({ completed: chore.completed }).eq('id', chore.id);
            if (choreResult.error) { showUndoToast('Error updating chore'); console.error(choreResult.error); }
            // If completed, add reward to member's earned
            if (chore.completed) {
                var member = familyMembers.find(function(m) { return m.id === chore.assignee; });
                if (member) {
                    member.earned = (member.earned || 0) + chore.reward;
                    member.allowance = (member.allowance || 0) + chore.reward;
                    var earnResult = await supabase.from('family_members').update({ earned: member.earned, allowance: member.allowance }).eq('id', member.id);
                    if (earnResult.error) { showUndoToast('Error updating earnings'); console.error(earnResult.error); }
                }
            }
            renderChores();
            renderAllowances();
            renderMembers();
        });
    });

    // Delete chore
    list.querySelectorAll('.chore-actions button').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            await supabase.from('family_chores').delete().eq('id', btn.dataset.id);
            familyChores = familyChores.filter(function(c) { return c.id !== btn.dataset.id; });
            renderChores();
        });
    });
}

function renderFamilyGoals() {
    var grid = document.getElementById('familyGoalsGrid');
    var empty = document.getElementById('emptyFamilyGoals');
    if (!grid) return;
    grid.querySelectorAll('.family-goal-card').forEach(function(c) { c.remove(); });
    if (familyGoals.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    var sym = getCurrencySymbol();
    familyGoals.forEach(function(g) {
        var pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
        var deadlineStr = g.deadline ? new Date(g.deadline).toLocaleDateString('default', { month: 'short', year: 'numeric' }) : '';

        var contribHtml = '';
        if (g.contributions && Object.keys(g.contributions).length > 0) {
            contribHtml = '<div class="family-goal-contributors"><h5>Contributors</h5>';
            Object.keys(g.contributions).forEach(function(memId) {
                var member = familyMembers.find(function(m) { return m.id === memId; });
                if (member) {
                    contribHtml += '<div class="contributor-row">' +
                        '<div class="contributor-dot" style="background:' + member.color + ';"></div>' +
                        '<span class="contributor-name">' + escapeHtml(member.name) + '</span>' +
                        '<span class="contributor-amount">' + sym + Number(g.contributions[memId]).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + '</span>' +
                    '</div>';
                }
            });
            contribHtml += '</div>';
        }

        var card = document.createElement('div');
        card.className = 'family-goal-card';
        card.innerHTML =
            '<div class="family-goal-header">' +
                '<div class="family-goal-name">' + escapeHtml(g.name) + '</div>' +
                (deadlineStr ? '<div class="family-goal-deadline">' + deadlineStr + '</div>' : '') +
            '</div>' +
            '<div class="family-goal-progress">' +
                '<div class="family-goal-bar-track"><div class="family-goal-bar-fill" style="width:' + pct + '%;"></div></div>' +
                '<div class="family-goal-amounts"><span class="family-goal-saved">' + sym + Number(g.saved).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + '</span><span class="family-goal-target">' + sym + Number(g.target).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + '</span></div>' +
            '</div>' +
            contribHtml +
            '<div class="family-goal-actions">' +
                '<button class="btn-contribute" data-id="' + g.id + '">Contribute</button>' +
                '<button class="btn-goal-delete" data-id="' + g.id + '">Delete</button>' +
            '</div>';
        grid.appendChild(card);
    });

    // Contribute
    grid.querySelectorAll('.btn-contribute').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            if (familyMembers.length === 0) { alert('Add family members first!'); return; }
            var memberNames = familyMembers.map(function(m, i) { return (i + 1) + '. ' + m.name; }).join('\n');
            var choice = prompt('Who is contributing?\n' + memberNames + '\n\nEnter number:');
            if (!choice) return;
            var idx = parseInt(choice) - 1;
            if (idx < 0 || idx >= familyMembers.length) { alert('Invalid choice'); return; }
            var amount = prompt('How much to contribute?');
            if (!amount || isNaN(parseFloat(amount))) return;
            var goal = familyGoals.find(function(g) { return g.id === btn.dataset.id; });
            var member = familyMembers[idx];
            if (goal && member) {
                var amt = parseFloat(amount);
                goal.saved += amt;
                if (!goal.contributions) goal.contributions = {};
                goal.contributions[member.id] = (goal.contributions[member.id] || 0) + amt;
                var goalResult = await supabase.from('family_goals').update({ saved: goal.saved }).eq('id', goal.id);
                if (goalResult.error) { showUndoToast('Error saving goal progress'); console.error(goalResult.error); }
                var contribResult = await supabase.from('family_goal_contributions').insert({ goal_id: goal.id, member_id: member.id, amount: amt, user_id: currentUser.id });
                if (contribResult.error) { console.error(contribResult.error); }
                renderFamilyGoals();
            }
        });
    });

    // Delete goal
    grid.querySelectorAll('.btn-goal-delete').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            if (!confirm('Delete this family goal?')) return;
            await supabase.from('family_goals').delete().eq('id', btn.dataset.id);
            familyGoals = familyGoals.filter(function(g) { return g.id !== btn.dataset.id; });
            renderFamilyGoals();
        });
    });
}

async function reloadDataForMode() {
    try {
        var result = await supabase
            .from('user_settings')
            .select('*')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        if (result.data) {
            if (accountMode === 'business') {
                userSettings = Object.assign({}, result.data, {
                    currency: result.data.biz_currency || result.data.currency || 'USD',
                    income: result.data.biz_income || 0,
                    savings_goal: result.data.biz_savings_goal || 0
                });
            } else if (accountMode === 'family') {
                userSettings = Object.assign({}, result.data, {
                    currency: result.data.fam_currency || result.data.currency || 'USD',
                    income: result.data.fam_income || 0,
                    savings_goal: result.data.fam_savings_goal || 0
                });
            } else {
                userSettings = result.data;
            }
        } else {
            userSettings = { currency: 'USD', income: 0, savings_goal: 0, user_id: currentUser.id };
        }
        swapExpenseCategories(accountMode);
        loadCustomCategories();
        // Set activeGroupId before loading family data
        if (accountMode === 'family') {
            await resolveActiveGroup();
        } else {
            activeGroupId = null;
            myFamilyRole = null;
        }
        await Promise.all([loadExpenses(), loadSavingsGoals()]);
        loadLinkedAccounts();
        loadBusinessData();
        if (accountMode === 'family') await loadFamilyData();
    } catch(e) {
        console.warn('reloadDataForMode error:', e);
    }
}

function setupNav() {
    // Reset to Overview page on fresh sign-in (not on normal reload)
    if (sessionStorage.getItem('bw-fresh-login')) {
        sessionStorage.removeItem('bw-fresh-login');
        var items2 = document.querySelectorAll('.nav-item');
        items2.forEach(function(i) { i.classList.remove('active'); });
        var overviewNav = document.querySelector('.nav-item[data-page="overview"]');
        if (overviewNav) overviewNav.classList.add('active');
        document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
        var overviewPage = document.getElementById('page-overview');
        if (overviewPage) overviewPage.classList.add('active');
    }

    var items = document.querySelectorAll('.nav-item');

    // Page restore happens after data loads — see restoreSavedPage()

    items.forEach(function(item) {
        item.addEventListener('click', function() {
            if (!item.dataset.page) return;
            items.forEach(function(i) { i.classList.remove('active'); });
            item.classList.add('active');
            document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
            document.getElementById('page-' + item.dataset.page).classList.add('active');
            localStorage.setItem('bw-active-page', item.dataset.page);
            if (item.dataset.page === 'account') renderAccount();
            if (item.dataset.page === 'pnl') renderPnL();
            if (item.dataset.page === 'tax') renderTax();
            if (item.dataset.page === 'invoices') { loadInvoices(); }
            if (item.dataset.page === 'clients') { loadClients(); }
            if (item.dataset.page === 'members') { renderMembers(); }
            if (item.dataset.page === 'allowances') { renderAllowances(); }
            if (item.dataset.page === 'chores') { renderChores(); }
            if (item.dataset.page === 'family-goals') { renderFamilyGoals(); }
            if (item.dataset.page === 'family-tracking') { updateTrackingLabels(); loadTrackingState(); }
            showPageHints(item.dataset.page);
            var fab = document.getElementById('fabAdd');
            if (item.dataset.page !== 'overview' && item.dataset.page !== 'expenses' && item.dataset.page !== 'advice') {
                fab.style.display = 'none';
            } else {
                fab.style.display = '';
            }
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('sidebarOverlay').classList.remove('active');
        });
    });
    document.getElementById('menuToggle').addEventListener('click', function() {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('sidebarOverlay').classList.toggle('active');
        document.getElementById('fabAdd').style.display = document.getElementById('sidebar').classList.contains('open') ? 'none' : '';
    });
    document.getElementById('sidebarOverlay').addEventListener('click', function() {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebarOverlay').classList.remove('active');
        document.getElementById('fabAdd').style.display = '';
    });
}

function setupModals() {
    // All add expense buttons
    document.querySelectorAll('#addExpenseBtn, #addExpenseBtn2').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.getElementById('expenseModal').classList.remove('hidden');
        });
    });
    document.getElementById('closeExpenseModal').addEventListener('click', function() {
        document.getElementById('expenseModal').classList.add('hidden');
    });

    // Savings goal modal
    document.getElementById('addGoalBtn').addEventListener('click', function() {
        document.getElementById('goalModal').classList.remove('hidden');
    });
    document.getElementById('addSavingsEntryBtn').addEventListener('click', function() {
        // Switch to overview page and pre-fill expense form with Savings category
        var overviewNav = document.querySelector('.nav-item[data-page="overview"]');
        if (overviewNav) overviewNav.click();
        setTimeout(function() {
            var catSelect = document.getElementById('expCategory');
            if (catSelect) catSelect.value = 'Savings';
            var descInput = document.getElementById('expDescription');
            if (descInput) { descInput.value = ''; descInput.focus(); descInput.placeholder = 'e.g. Transfer to savings account'; }
            var amtInput = document.getElementById('expAmount');
            if (amtInput) amtInput.value = '';
        }, 100);
    });
    document.getElementById('closeGoalModal').addEventListener('click', function() {
        document.getElementById('goalModal').classList.add('hidden');
    });

    // Add to goal modal
    document.getElementById('closeAddToGoalModal').addEventListener('click', function() {
        document.getElementById('addToGoalModal').classList.add('hidden');
    });
}

function autoDetectCurrency() {
    var timezoneCurrency = {
        'Africa/Johannesburg': 'ZAR', 'Africa/Lagos': 'NGN', 'Africa/Nairobi': 'KES',
        'Africa/Accra': 'GHS', 'Africa/Gaborone': 'BWP', 'Africa/Maputo': 'MZN',
        'Africa/Cairo': 'EGP', 'Africa/Casablanca': 'MAD', 'Africa/Algiers': 'DZD',
        'America/New_York': 'USD', 'America/Chicago': 'USD', 'America/Denver': 'USD',
        'America/Los_Angeles': 'USD', 'America/Toronto': 'CAD', 'America/Vancouver': 'CAD',
        'America/Sao_Paulo': 'BRL', 'America/Mexico_City': 'MXN', 'America/Argentina/Buenos_Aires': 'ARS',
        'Europe/London': 'GBP', 'Europe/Paris': 'EUR', 'Europe/Berlin': 'EUR',
        'Europe/Madrid': 'EUR', 'Europe/Rome': 'EUR', 'Europe/Amsterdam': 'EUR',
        'Europe/Zurich': 'CHF', 'Europe/Stockholm': 'SEK', 'Europe/Oslo': 'NOK',
        'Europe/Copenhagen': 'DKK', 'Europe/Warsaw': 'PLN', 'Europe/Istanbul': 'TRY',
        'Asia/Kolkata': 'INR', 'Asia/Tokyo': 'JPY', 'Asia/Shanghai': 'CNY',
        'Asia/Hong_Kong': 'HKD', 'Asia/Singapore': 'SGD', 'Asia/Seoul': 'KRW',
        'Asia/Dubai': 'AED', 'Asia/Riyadh': 'SAR', 'Asia/Bangkok': 'THB',
        'Asia/Kuala_Lumpur': 'MYR', 'Asia/Jakarta': 'IDR', 'Asia/Manila': 'PHP',
        'Asia/Karachi': 'PKR', 'Asia/Dhaka': 'BDT', 'Asia/Colombo': 'LKR',
        'Pacific/Auckland': 'NZD', 'Australia/Sydney': 'AUD', 'Australia/Melbourne': 'AUD'
    };
    try {
        var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        var currency = timezoneCurrency[tz];
        if (currency) {
            var sel = document.getElementById('setupCurrency');
            for (var i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === currency) {
                    sel.selectedIndex = i;
                    break;
                }
            }
        }
    } catch(e) {}
}

function setupSetupForm() {
    autoDetectCurrency();
    document.getElementById('setupForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        userSettings = {
            user_id: currentUser.id,
            currency: document.getElementById('setupCurrency').value,
            income: parseFloat(document.getElementById('setupIncome').value),
            savings_goal: parseFloat(document.getElementById('setupGoal').value),
            setup_done: true
        };
        var existing = await supabase.from('user_settings').select('id')
            .eq('user_id', currentUser.id).maybeSingle();
        if (existing.data) {
            await supabase.from('user_settings').update(userSettings).eq('id', existing.data.id);
        } else {
            await supabase.from('user_settings').insert(userSettings);
        }
        document.getElementById('setupModal').classList.add('hidden');
        document.querySelector('.main-content').classList.add('loaded');
        loadCustomCategories();
        loadExpenses();
        loadSavingsGoals();
        loadCurrencyPage();
    });
}

function setupExpenseForm() {
    // Auto-fill tithe amount when Tithe category is selected
    var expCat = document.getElementById('expCategory');
    var expAmt = document.getElementById('expAmount');
    var expDesc = document.getElementById('expDescription');
    if (expCat) {
        expCat.addEventListener('change', function() {
            if (expCat.value === 'Tithe') {
                var titheAmt = (parseFloat(userSettings.income) || 0) * 0.1;
                if (titheAmt > 0) {
                    expAmt.value = titheAmt.toFixed(2);
                    expDesc.value = 'Monthly Tithe (10%)';
                }
            }
        });
    }

    document.getElementById('expenseForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var expense = {
            user_id: currentUser.id,
            category: document.getElementById('expCategory').value,
            description: document.getElementById('expDescription').value,
            amount: parseFloat(document.getElementById('expAmount').value),
            date: document.getElementById('expDate').value,
            recurring: document.getElementById('expRecurring').value,
            account_mode: accountMode
        };
        if (accountMode === 'family' && activeGroupId) {
            expense.group_id = activeGroupId;
            if (myFamilyRole === 'kid') {
                await supabase.from('family_pending').insert({
                    group_id: activeGroupId,
                    requested_by: currentUser.id,
                    requester_name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Member',
                    action: 'add_expense',
                    payload: expense
                });
                showUndoToast('Expense submitted for parent approval');
                notifyPendingSubmitted('add_expense', expense.category + ' — ' + fmt(expense.amount));
                document.getElementById('expenseForm').reset();
                document.getElementById('expDate').value = new Date().toISOString().split('T')[0];
                document.getElementById('expenseModal').classList.add('hidden');
                loadPendingApprovals();
                return;
            }
        }
        var result = await supabase.from('expenses').insert(expense);
        if (result.error) {
            showUndoToast('Failed to add expense — please try again');
            console.error('Expense insert error:', result.error);
            return;
        }
        auditLog('expense_added', { category: expense.category, amount: expense.amount });
        notifyExpenseAdded(expense);
        document.getElementById('expenseForm').reset();
        document.getElementById('expDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('expenseModal').classList.add('hidden');
        loadExpenses();
    });
}

function setupSavingsForm() {
    document.getElementById('updateGoalForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var newGoal = document.getElementById('newGoal').value;
        var newIncome = document.getElementById('newIncome').value;
        if (newGoal) userSettings.savings_goal = parseFloat(newGoal);
        if (newIncome) userSettings.income = parseFloat(newIncome);
        var savingsUpdate;
        if (accountMode === 'business') savingsUpdate = { biz_income: userSettings.income, biz_savings_goal: userSettings.savings_goal };
        else if (accountMode === 'family') savingsUpdate = { fam_income: userSettings.income, fam_savings_goal: userSettings.savings_goal };
        else savingsUpdate = { income: userSettings.income, savings_goal: userSettings.savings_goal };
        await supabase.from('user_settings').update(savingsUpdate).eq('user_id', currentUser.id);
        document.getElementById('updateGoalForm').reset();
        loadExpenses();
    });

    document.getElementById('resetBudgetBtn').addEventListener('click', async function() {
        if (!confirm('Reset your monthly income and savings goal to $0?')) return;
        userSettings.income = 0;
        userSettings.savings_goal = 0;
        var resetUpdate;
        if (accountMode === 'business') resetUpdate = { biz_income: 0, biz_savings_goal: 0 };
        else if (accountMode === 'family') resetUpdate = { fam_income: 0, fam_savings_goal: 0 };
        else resetUpdate = { income: 0, savings_goal: 0 };
        await supabase.from('user_settings').update(resetUpdate).eq('user_id', currentUser.id);
        loadExpenses();
    });
}

// SAVINGS GOALS
function setupGoalForms() {
    document.getElementById('goalForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var goal = {
            user_id: currentUser.id,
            name: document.getElementById('goalName').value,
            target_amount: parseFloat(document.getElementById('goalTarget').value),
            saved_amount: 0,
            monthly_contribution: parseFloat(document.getElementById('goalMonthly').value),
            deadline: document.getElementById('goalDeadline').value || null,
            account_mode: accountMode
        };
        await supabase.from('savings_goals').insert(goal);
        auditLog('goal_created', { name: goal.name, target: goal.target_amount });
        document.getElementById('goalForm').reset();
        document.getElementById('goalModal').classList.add('hidden');
        loadSavingsGoals();
    });

    document.getElementById('addToGoalForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var goalId = document.getElementById('addToGoalId').value;
        var amount = parseFloat(document.getElementById('addToGoalAmount').value);
        var goal = savingsGoals.find(function(g) { return g.id === goalId; });
        if (goal) {
            var newSaved = goal.saved_amount + amount;
            await supabase.from('savings_goals').update({
                saved_amount: newSaved
            }).eq('id', goalId);
            auditLog('goal_funded', { name: goal.name, amount: amount, new_total: newSaved });
            if (newSaved >= goal.target_amount && goal.saved_amount < goal.target_amount) {
                fireConfetti();
            }
        }
        document.getElementById('addToGoalForm').reset();
        document.getElementById('addToGoalModal').classList.add('hidden');
        loadSavingsGoals();
    });
}

async function loadSavingsGoals() {
    var result = await supabase
        .from('savings_goals')
        .select('*')
        .eq('user_id', currentUser.id)
        .eq('account_mode', accountMode)
        .order('created_at', { ascending: false });
    savingsGoals = result.data || [];
    // Migrate legacy goals with no account_mode to personal
    if (savingsGoals.length === 0 && accountMode === 'personal') {
        var legacy = await supabase.from('savings_goals').select('*')
            .eq('user_id', currentUser.id).is('account_mode', null)
            .order('created_at', { ascending: false });
        if (legacy.data && legacy.data.length > 0) {
            savingsGoals = legacy.data;
            supabase.from('savings_goals').update({ account_mode: 'personal' })
                .eq('user_id', currentUser.id).is('account_mode', null).then(function() {});
        }
    }
    renderSavingsGoals();
}

function renderSavingsGoals() {
    var container = document.getElementById('savingsGoalsList');
    if (!container) return;
    // Preserve emptyGoals before clearing innerHTML
    var empty = document.getElementById('emptyGoals');
    if (empty) empty.remove();
    container.innerHTML = '';

    if (savingsGoals.length === 0) {
        if (empty) {
            container.appendChild(empty);
            empty.classList.remove('hidden');
        }
        return;
    }
    if (empty) {
        empty.classList.add('hidden');
        container.appendChild(empty);
    }

    savingsGoals.forEach(function(goal, idx) {
        var pct = goal.target_amount > 0 ? Math.min(100, (goal.saved_amount / goal.target_amount) * 100) : 0;
        var color = goalColors[idx % goalColors.length];
        var monthsLeft = goal.monthly_contribution > 0 ? Math.ceil((goal.target_amount - goal.saved_amount) / goal.monthly_contribution) : 0;
        var remaining = goal.target_amount - goal.saved_amount;

        var advice = '';
        if (pct >= 100) {
            advice = 'You did it! You\'ve reached your goal. Time to treat yourself.';
        } else if (goal.deadline) {
            var deadlineDate = new Date(goal.deadline);
            var now = new Date();
            var monthsUntilDeadline = Math.max(0, (deadlineDate.getFullYear() - now.getFullYear()) * 12 + deadlineDate.getMonth() - now.getMonth());
            var neededPerMonth = remaining / Math.max(1, monthsUntilDeadline);
            if (neededPerMonth > goal.monthly_contribution) {
                advice = 'You need ' + fmt(neededPerMonth) + '/month to hit your deadline. Consider increasing your contribution from ' + fmt(goal.monthly_contribution) + '.';
            } else {
                advice = 'You\'re on track! At your current rate you\'ll reach this goal before your deadline.';
            }
        } else if (monthsLeft > 0) {
            advice = 'At ' + fmt(goal.monthly_contribution) + '/month, you\'ll reach this goal in about ' + monthsLeft + ' month' + (monthsLeft === 1 ? '' : 's') + '.';
        }

        var card = document.createElement('div');
        card.className = 'goal-card';
        card.innerHTML =
            '<div class="goal-header">' +
                '<div class="goal-name-row">' +
                    '<div class="goal-dot" style="background:' + color + '"></div>' +
                    '<h4>' + escapeHtml(goal.name) + '</h4>' +
                '</div>' +
                '<div class="goal-actions">' +
                    '<button class="btn-goal-add" data-id="' + goal.id + '" data-name="' + escapeHtml(goal.name) + '">+ Add</button>' +
                    '<button class="btn-delete btn-goal-delete" data-id="' + goal.id + '">' +
                        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="goal-progress">' +
                '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%;background:' + color + ';box-shadow:0 0 12px ' + color + '40"></div></div>' +
                '<div class="goal-stats">' +
                    '<span>' + fmt(goal.saved_amount) + ' saved</span>' +
                    '<span>' + Math.round(pct) + '%</span>' +
                    '<span>' + fmt(goal.target_amount) + ' goal</span>' +
                '</div>' +
            '</div>' +
            (advice ? '<p class="goal-advice">' + advice + '</p>' : '');

        container.appendChild(card);
    });

    // Add funds buttons
    container.querySelectorAll('.btn-goal-add').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.getElementById('addToGoalId').value = btn.dataset.id;
            document.getElementById('addToGoalName').textContent = 'Adding to: ' + btn.dataset.name;
            document.getElementById('addToGoalModal').classList.remove('hidden');
        });
    });

    // Delete buttons
    container.querySelectorAll('.btn-goal-delete').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            auditLog('goal_deleted', { name: btn.dataset.name });
            await supabase.from('savings_goals').delete().eq('id', btn.dataset.id);
            loadSavingsGoals();
        });
    });
}

// Load expenses
async function loadExpenses() {
    var query = supabase.from('expenses').select('*');
    if (accountMode === 'family' && activeGroupId) {
        // Shared family mode: load all group expenses
        query = query.eq('group_id', activeGroupId).eq('account_mode', 'family');
    } else {
        query = query.eq('user_id', currentUser.id).eq('account_mode', accountMode);
    }
    var result = await query.order('date', { ascending: false });
    expenses = result.data || [];
    // Migrate legacy expenses with no account_mode to personal
    if (expenses.length === 0 && accountMode === 'personal') {
        var legacy = await supabase.from('expenses').select('*')
            .eq('user_id', currentUser.id).is('account_mode', null)
            .order('date', { ascending: false });
        if (legacy.data && legacy.data.length > 0) {
            expenses = legacy.data;
            // Auto-migrate them in background
            supabase.from('expenses').update({ account_mode: 'personal' })
                .eq('user_id', currentUser.id).is('account_mode', null).then(function() {});
        }
    }
    renderOverview();
    renderTrendChart();
    renderAllExpenses();
    renderSavingsPage();
    renderAdvice();
    renderAIInsights();
    renderStreak();
    renderMonthlySummary();
    renderBudgetWarnings();
    // Auto-sync to family if sharing is enabled
    if (accountMode === 'family' && familyLink && familyLink.sharing_enabled) {
        syncSpendingToFamily();
    }
}

function fmt(amount) {
    var sym = { ZAR: 'R', USD: '$', EUR: '\u20AC', GBP: '\u00A3', NGN: '\u20A6', KES: 'KSh', GHS: 'GH\u20B5', INR: '\u20B9', BRL: 'R$', JPY: '\u00A5', AUD: 'A$', CAD: 'C$', CNY: '\u00A5', BWP: 'P', MZN: 'MT' };
    var s = sym[userSettings.currency] || userSettings.currency + ' ';
    return s + Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function currentMonthExpenses() {
    var now = new Date();
    var key = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    return expenses.filter(function(e) { return e.date.startsWith(key); });
}

function currentMonthSavings() {
    return currentMonthExpenses().filter(function(e) { return e.category === 'Savings'; });
}

function monthSavingsTotal() {
    return currentMonthSavings().reduce(function(s, e) { return s + e.amount; }, 0);
}

// Deduplicate for recent view - group by category+description+amount, show once with count
function dedupeRecent(list) {
    var seen = {};
    var unique = [];
    list.forEach(function(e) {
        var key = e.category + '|' + e.description + '|' + e.amount;
        if (!seen[key]) {
            seen[key] = true;
            unique.push(e);
        }
    });
    return unique;
}

function isLight() {
    return document.body.classList.contains('light');
}

function chartColors() {
    var light = isLight();
    return {
        text: light ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.4)',
        textStrong: light ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.5)',
        grid: light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)',
        legendText: light ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.5)',
        tick: light ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.3)'
    };
}

// OVERVIEW
function getFamilyJointIncome() {
    if (accountMode !== 'family' || !activeGroupId || familyLinkMembers.length === 0) return userSettings.income || 0;
    var joint = 0;
    familyLinkMembers.forEach(function(link) { joint += Number(link.income_contribution) || 0; });
    return joint > 0 ? joint : (userSettings.income || 0);
}

function renderOverview() {
    var monthExp = currentMonthExpenses();
    var totalSpent = monthExp.reduce(function(s, e) { return s + e.amount; }, 0);
    var effectiveIncome = (accountMode === 'family' && activeGroupId) ? getFamilyJointIncome() : userSettings.income;
    var remaining = effectiveIncome - totalSpent;
    var saved = monthSavingsTotal();

    // Animate counters on first render, plain text on re-render
    if (!pieChart) {
        setTimeout(animateStatCounters, 100);
    } else {
        document.getElementById('statIncome').textContent = fmt(effectiveIncome);
        document.getElementById('statSpent').textContent = fmt(totalSpent);
        document.getElementById('statRemaining').textContent = fmt(remaining);
        document.getElementById('statSaved').textContent = fmt(saved);
        var sym = { ZAR: 'R', USD: '$', EUR: '\u20AC', GBP: '\u00A3', NGN: '\u20A6', KES: 'KSh', GHS: 'GH\u20B5', INR: '\u20B9', BRL: 'R$', JPY: '\u00A5', AUD: 'A$', CAD: 'C$', CNY: '\u00A5', BWP: 'P', MZN: 'MT' };
        var prefix = sym[userSettings.currency] || userSettings.currency + ' ';
        renderIncomeBreakdown(effectiveIncome, prefix);
    }

    var pct = userSettings.savings_goal > 0 ? Math.min(100, (saved / userSettings.savings_goal) * 100) : 0;
    document.getElementById('savingsProgress').style.width = pct + '%';
    document.getElementById('savedAmount').textContent = 'Saved: ' + fmt(saved);
    document.getElementById('goalAmount').textContent = 'Goal: ' + fmt(userSettings.savings_goal);

    // Pie chart
    var catTotals = {};
    monthExp.forEach(function(e) {
        catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
    });
    var labels = Object.keys(catTotals);
    var data = Object.values(catTotals);
    var colors = labels.map(function(l) { return categoryColors[l] || '#6b7280'; });

    var pieEmpty = document.getElementById('pieEmpty');
    if (labels.length === 0) {
        pieEmpty.classList.remove('hidden');
    } else {
        pieEmpty.classList.add('hidden');
    }

    var isFirstLoad = !pieChart;
    var cc = chartColors();
    if (pieChart) pieChart.destroy();
    var now2 = new Date();
    var currentKey = now2.getFullYear() + '-' + String(now2.getMonth() + 1).padStart(2, '0');
    pieChart = new Chart(document.getElementById('pieChart').getContext('2d'), {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderWidth: isLight() ? 2 : 0, borderColor: isLight() ? '#fff' : 'transparent', hoverOffset: 8 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            animation: { animateRotate: isFirstLoad, animateScale: isFirstLoad, duration: isFirstLoad ? 500 : 0 },
            onClick: function() { showDrillDown('Daily Breakdown - ' + now2.toLocaleString('default', { month: 'long' }), currentKey); },
            plugins: {
                legend: { position: 'right', labels: { color: cc.legendText, font: { size: 11, family: 'Inter', weight: isLight() ? '500' : '400' }, padding: 14, usePointStyle: true } },
                tooltip: { backgroundColor: isLight() ? 'rgba(26,26,46,0.9)' : 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: 'rgba(255,255,255,0.8)', borderColor: isLight() ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12, cornerRadius: 10, titleFont: { family: 'Inter', weight: '600' }, bodyFont: { family: 'Inter' } }
            }
        }
    });

    // Bar chart
    var isFirstBar = !barChart;
    if (barChart) barChart.destroy();
    barChart = new Chart(document.getElementById('barChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: accountMode === 'business' ? ['Revenue', 'Expenses', 'Budget Target', 'Surplus'] : ['Income', 'Expenses', 'Savings Goal', 'Actual Saved'],
            datasets: [{ data: [userSettings.income, totalSpent, userSettings.savings_goal, saved], backgroundColor: isLight() ? ['rgba(16,185,129,0.8)', 'rgba(239,68,68,0.8)', 'rgba(139,92,246,0.8)', 'rgba(6,182,212,0.8)'] : ['#10b981', '#ef4444', '#8b5cf6', '#06b6d4'], borderWidth: 0, borderRadius: 8, barThickness: 40 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: { duration: isFirstBar ? 500 : 0, easing: 'easeOutQuart' },
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: isLight() ? 'rgba(26,26,46,0.9)' : 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: 'rgba(255,255,255,0.8)', borderColor: isLight() ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12, cornerRadius: 10, titleFont: { family: 'Inter', weight: '600' }, bodyFont: { family: 'Inter' } }
            },
            scales: {
                y: { grid: { color: cc.grid }, ticks: { color: cc.tick } },
                x: { grid: { display: false }, ticks: { color: cc.text, font: { size: 11, weight: isLight() ? '500' : '400' } } }
            }
        }
    });

    // Recent table (deduped)
    var tbody = document.getElementById('recentBody');
    var empty = document.getElementById('emptyRecent');
    tbody.innerHTML = '';
    var recent = dedupeRecent(monthExp).slice(0, 8);
    if (recent.length === 0) {
        empty.classList.remove('hidden');
    } else {
        empty.classList.add('hidden');
        recent.forEach(function(e) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + e.date + '</td><td><span class="category-badge" style="background:' + (categoryColors[e.category] || '#6b7280') + '20;color:' + (categoryColors[e.category] || '#6b7280') + '">' + e.category + '</span></td><td>' + escapeHtml(e.description) + '</td><td>' + fmt(e.amount) + '</td><td style="display:flex;gap:4px;"><button class="btn-move-expense" data-id="' + e.id + '" title="Move to another account" style="background:none;border:none;cursor:pointer;padding:4px;opacity:0.5;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8l4 4-4 4"/><path d="M2 12h20"/></svg></button><button class="btn-delete" data-id="' + e.id + '"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></td>';
            tbody.appendChild(tr);
        });
        attachDeleteHandlers(tbody);
        attachMoveHandlers(tbody);
    }

    renderMonthComparison();
    renderBudgetRing();
}

// ALL EXPENSES
function renderAllExpenses() {
    var filterVal = document.getElementById('monthFilter').value;
    var searchVal = (document.getElementById('expenseSearch').value || '').toLowerCase();
    var catVal = document.getElementById('categoryFilter').value;
    var filtered = expenses.filter(function(e) {
        if (!e.date.startsWith(filterVal)) return false;
        if (catVal && e.category !== catVal) return false;
        if (searchVal && e.description.toLowerCase().indexOf(searchVal) === -1 && e.category.toLowerCase().indexOf(searchVal) === -1) return false;
        return true;
    });
    var tbody = document.getElementById('allExpensesBody');
    var empty = document.getElementById('emptyAll');
    tbody.innerHTML = '';
    if (filtered.length === 0) {
        empty.classList.remove('hidden');
    } else {
        empty.classList.add('hidden');
        filtered.forEach(function(e) {
            var rec = e.recurring === 'no' ? '-' : e.recurring;
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + e.date + '</td><td><span class="category-badge" style="background:' + (categoryColors[e.category] || '#6b7280') + '20;color:' + (categoryColors[e.category] || '#6b7280') + '">' + e.category + '</span></td><td>' + escapeHtml(e.description) + '</td><td>' + rec + '</td><td>' + fmt(e.amount) + '</td><td style="display:flex;gap:4px;"><button class="btn-move-expense" data-id="' + e.id + '" title="Move to another account" style="background:none;border:none;cursor:pointer;padding:4px;opacity:0.5;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8l4 4-4 4"/><path d="M2 12h20"/></svg></button><button class="btn-delete" data-id="' + e.id + '"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></td>';
            tbody.appendChild(tr);
        });
        attachDeleteHandlers(tbody);
        attachMoveHandlers(tbody);
    }
}

function attachDeleteHandlers(container) {
    container.querySelectorAll('.btn-delete').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            var row = btn.closest('tr');
            var id = btn.dataset.id;
            var deletedExpense = expenses.find(function(e) { return e.id === id; });
            // Remove from UI
            row.style.transition = 'opacity 0.3s, transform 0.3s';
            row.style.opacity = '0';
            row.style.transform = 'translateX(20px)';
            expenses = expenses.filter(function(e) { return e.id !== id; });
            // Delete from DB immediately
            auditLog('expense_deleted', { category: deletedExpense ? deletedExpense.category : null, amount: deletedExpense ? deletedExpense.amount : null });
            var delResult = await supabase.from('expenses').delete().eq('id', id).eq('user_id', currentUser.id);
            if (delResult.error) {
                console.error('Delete failed:', delResult.error);
                showUndoToast('Error deleting expense');
                loadExpenses();
                return;
            }
            setTimeout(function() {
                row.remove();
                renderOverview();
                renderTrendChart();
                renderSavingsPage();
                renderAdvice();
            }, 300);
            // Show undo toast — undo re-inserts the row
            showUndoToast('Expense deleted', async function() {
                if (deletedExpense) {
                    var copy = Object.assign({}, deletedExpense);
                    delete copy.id;
                    var reinsert = await supabase.from('expenses').insert(copy).select();
                    if (reinsert.data && reinsert.data[0]) {
                        expenses.push(reinsert.data[0]);
                    } else {
                        expenses.push(deletedExpense);
                    }
                    expenses.sort(function(a, b) { return b.date.localeCompare(a.date); });
                    renderOverview();
                    renderAllExpenses();
                    renderTrendChart();
                    renderSavingsPage();
                    renderAdvice();
                }
            });
        });
    });
}

// Phase 2: Move to Account — attach move handlers to expense tables
function attachMoveHandlers(container) {
    container.querySelectorAll('.btn-move-expense').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var expId = btn.dataset.id;
            var exp = expenses.find(function(e) { return e.id === expId; });
            if (!exp) return;
            var modal = document.getElementById('moveAccountModal');
            var info = document.getElementById('moveExpenseInfo');
            info.innerHTML = '<div style="font-weight:600;">' + escapeHtml(exp.category) + '</div>' +
                '<div style="color:var(--text-secondary);font-size:0.8rem;">' + escapeHtml(exp.description) + ' — ' + fmt(exp.amount) + '</div>' +
                '<div style="color:var(--text-secondary);font-size:0.75rem;margin-top:4px;">' + exp.date + '</div>';
            // Hide the current mode button
            modal.querySelectorAll('.move-option').forEach(function(opt) {
                opt.style.display = opt.dataset.mode === accountMode ? 'none' : '';
            });
            modal.dataset.expenseId = expId;
            modal.classList.remove('hidden');
        });
    });
}

function setupMoveAccountModal() {
    var modal = document.getElementById('moveAccountModal');
    if (!modal) return;
    document.getElementById('closeMoveAccountModal').addEventListener('click', function() {
        modal.classList.add('hidden');
    });
    modal.querySelectorAll('.move-option').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            var targetMode = btn.dataset.mode;
            var expId = modal.dataset.expenseId;
            if (!expId || !targetMode) return;
            var exp = expenses.find(function(e) { return e.id === expId; });
            if (!exp) return;

            var updateData = { account_mode: targetMode };
            // If moving to family and user has a group, attach group_id
            if (targetMode === 'family' && activeGroupId) {
                updateData.group_id = activeGroupId;
            } else {
                updateData.group_id = null;
            }

            await supabase.from('expenses').update(updateData).eq('id', expId);
            modal.classList.add('hidden');

            // Remove from current view
            expenses = expenses.filter(function(e) { return e.id !== expId; });
            renderOverview();
            renderAllExpenses();
            renderTrendChart();
            renderSavingsPage();

            var modeLabel = targetMode.charAt(0).toUpperCase() + targetMode.slice(1);
            showUndoToast('Expense moved to ' + modeLabel);
        });
    });
}

// Move Money Between Accounts
function setupMoveMoneyModal() {
    var modal = document.getElementById('moveMoneyModal');
    var btn = document.getElementById('moveMoneyBtn');
    if (!modal || !btn) return;

    btn.addEventListener('click', function() {
        // Default "From" to current account mode
        document.getElementById('moveMoneyFrom').value = accountMode;
        // Default "To" to something different
        var others = ['personal', 'business', 'family'].filter(function(m) { return m !== accountMode; });
        document.getElementById('moveMoneyTo').value = others[0];
        document.getElementById('moveMoneyAmount').value = '';
        document.getElementById('moveMoneyPreview').style.display = 'none';
        modal.classList.remove('hidden');
    });

    document.getElementById('closeMoveMoneyModal').addEventListener('click', function() {
        modal.classList.add('hidden');
    });

    // Live preview
    var amountInput = document.getElementById('moveMoneyAmount');
    var fromSelect = document.getElementById('moveMoneyFrom');
    var toSelect = document.getElementById('moveMoneyTo');
    function updatePreview() {
        var preview = document.getElementById('moveMoneyPreview');
        var amt = parseFloat(amountInput.value) || 0;
        var from = fromSelect.value;
        var to = toSelect.value;
        if (amt <= 0 || from === to) { preview.style.display = 'none'; return; }
        var sym = { ZAR: 'R', USD: '$', EUR: '\u20AC', GBP: '\u00A3' }[userSettings.currency] || userSettings.currency + ' ';
        var fromLabel = from.charAt(0).toUpperCase() + from.slice(1);
        var toLabel = to.charAt(0).toUpperCase() + to.slice(1);
        preview.innerHTML = fromLabel + ' income will decrease by <b>' + sym + amt.toFixed(2) + '</b><br>' + toLabel + ' income will increase by <b>' + sym + amt.toFixed(2) + '</b>';
        preview.style.display = '';
    }
    amountInput.addEventListener('input', updatePreview);
    fromSelect.addEventListener('change', updatePreview);
    toSelect.addEventListener('change', updatePreview);

    // Confirm transfer
    document.getElementById('moveMoneyConfirm').addEventListener('click', async function() {
        var amt = parseFloat(amountInput.value) || 0;
        var from = fromSelect.value;
        var to = toSelect.value;
        if (amt <= 0) { showUndoToast('Enter a valid amount'); return; }
        if (from === to) { showUndoToast('From and To must be different'); return; }

        var confirmBtn = document.getElementById('moveMoneyConfirm');
        confirmBtn.textContent = 'Transferring...';
        confirmBtn.disabled = true;

        try {
            // Fetch current settings to get latest values
            var result = await supabase.from('user_settings').select('income, biz_income, fam_income').eq('user_id', currentUser.id).single();
            if (!result.data) throw new Error('Settings not found');

            var incomeMap = {
                personal: result.data.income || 0,
                business: result.data.biz_income || 0,
                family: result.data.fam_income || 0
            };

            // Check source has enough
            if (incomeMap[from] < amt) {
                showUndoToast('Not enough funds in ' + from.charAt(0).toUpperCase() + from.slice(1) + ' (' + incomeMap[from].toFixed(2) + ')');
                confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:middle;margin-right:6px;"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg> Transfer';
                confirmBtn.disabled = false;
                return;
            }

            incomeMap[from] -= amt;
            incomeMap[to] += amt;

            var updateData = {
                income: incomeMap.personal,
                biz_income: incomeMap.business,
                fam_income: incomeMap.family
            };

            await supabase.from('user_settings').update(updateData).eq('user_id', currentUser.id);

            // Update local userSettings to reflect new income for current mode
            var modeIncomeKey = accountMode === 'business' ? 'business' : accountMode === 'family' ? 'family' : 'personal';
            userSettings.income = incomeMap[modeIncomeKey];

            modal.classList.add('hidden');

            var sym = { ZAR: 'R', USD: '$', EUR: '\u20AC', GBP: '\u00A3' }[userSettings.currency] || userSettings.currency + ' ';
            var fromLabel = from.charAt(0).toUpperCase() + from.slice(1);
            var toLabel = to.charAt(0).toUpperCase() + to.slice(1);

            // Capture values for undo
            var undoFrom = from;
            var undoTo = to;
            var undoAmt = amt;
            showUndoToast(sym + amt.toFixed(2) + ' transferred: ' + fromLabel + ' → ' + toLabel, async function() {
                try {
                    var r = await supabase.from('user_settings').select('income, biz_income, fam_income').eq('user_id', currentUser.id).single();
                    if (!r.data) return;
                    var map = { personal: r.data.income || 0, business: r.data.biz_income || 0, family: r.data.fam_income || 0 };
                    map[undoTo] -= undoAmt;
                    map[undoFrom] += undoAmt;
                    await supabase.from('user_settings').update({ income: map.personal, biz_income: map.business, fam_income: map.family }).eq('user_id', currentUser.id);
                    var mKey = accountMode === 'business' ? 'business' : accountMode === 'family' ? 'family' : 'personal';
                    userSettings.income = map[mKey];
                    renderOverview();
                    renderTrendChart();
                    renderSavingsPage();
                    showUndoToast('Transfer reversed');
                } catch (e) {
                    console.error('Undo transfer error:', e);
                    showUndoToast('Failed to undo transfer');
                }
            });

            // Refresh views
            renderOverview();
            renderTrendChart();
            renderSavingsPage();
        } catch (err) {
            console.error('Move money error:', err);
            showUndoToast('Transfer failed — please try again');
        }

        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:middle;margin-right:6px;"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg> Transfer';
        confirmBtn.disabled = false;
    });
}

// Phase 3: Plaid Transaction Routing
var pendingRoutingTx = null;

function showTxRoutingPopup(amount, description, transactionData) {
    var modal = document.getElementById('txRoutingModal');
    if (!modal) return;
    var sym = { ZAR: 'R', USD: '$', EUR: '\u20AC', GBP: '\u00A3' }[userSettings.currency] || userSettings.currency + ' ';
    document.getElementById('txRoutingAmount').textContent = sym + Number(amount).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
    document.getElementById('txRoutingDesc').textContent = description || 'Bank transaction';
    pendingRoutingTx = transactionData || { amount: amount, description: description };
    modal.classList.remove('hidden');
    // Notify user
    sendLocalNotification(
        'Money Received!',
        sym + Number(amount).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + ' — Which account should it go to?',
        'bw-tx-routing'
    );
}

function setupTxRoutingModal() {
    var modal = document.getElementById('txRoutingModal');
    if (!modal) return;

    modal.querySelectorAll('.tx-route-option').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            var targetMode = btn.dataset.mode;
            if (!pendingRoutingTx) return;
            btn.textContent = 'Adding...';
            btn.disabled = true;

            try {
                var catMap = {
                    'Food and Drink': 'Food', 'Travel': 'Transport', 'Transfer': 'Other',
                    'Payment': 'Other', 'Shops': 'Shopping', 'Recreation': 'Entertainment',
                    'Service': 'Utilities', 'Healthcare': 'Health', 'Bank Fees': 'Other'
                };
                var category = 'Other';
                if (pendingRoutingTx.category && pendingRoutingTx.category.length > 0) {
                    category = catMap[pendingRoutingTx.category[0]] || 'Other';
                }

                var expenseData = {
                    user_id: currentUser.id,
                    category: category,
                    description: pendingRoutingTx.description || pendingRoutingTx.name || 'Bank transaction',
                    amount: Math.abs(pendingRoutingTx.amount),
                    date: pendingRoutingTx.date || new Date().toISOString().split('T')[0],
                    recurring: 'no',
                    account_mode: targetMode
                };

                // If routing to family and user has a group, attach group_id
                if (targetMode === 'family' && activeGroupId) {
                    expenseData.group_id = activeGroupId;
                }

                await supabase.from('expenses').insert(expenseData);
                modal.classList.add('hidden');
                pendingRoutingTx = null;

                var modeLabel = targetMode.charAt(0).toUpperCase() + targetMode.slice(1);
                showUndoToast('Transaction added to ' + modeLabel + ' account');

                // Reload if on same mode
                if (targetMode === accountMode) {
                    loadExpenses();
                }
            } catch(err) {
                console.error('Routing error:', err);
                showUndoToast('Error routing transaction');
            }

            btn.disabled = false;
        });
    });

    document.getElementById('txRoutingSkip').addEventListener('click', function() {
        modal.classList.add('hidden');
        pendingRoutingTx = null;
        showUndoToast('Transaction skipped');
    });
}

// Phase 3: Process incoming transaction routing queue one at a time
var txRoutingQueue = [];
function processRoutingQueue(queue) {
    txRoutingQueue = queue || [];
    showNextRoutingTx();
}

function showNextRoutingTx() {
    if (txRoutingQueue.length === 0) return;
    var tx = txRoutingQueue.shift();
    showTxRoutingPopup(tx.amount, tx.name || tx.description, tx);

    // When this one is handled, show the next
    var modal = document.getElementById('txRoutingModal');
    var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
            if (modal.classList.contains('hidden') && txRoutingQueue.length > 0) {
                observer.disconnect();
                setTimeout(showNextRoutingTx, 400);
            }
        });
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
}

// SAVINGS PAGE
function renderSavingsPage() {
    var saved = monthSavingsTotal();

    document.getElementById('savingsGoalVal').textContent = fmt(userSettings.savings_goal);
    document.getElementById('savedThisMonth').textContent = fmt(saved);

    var pct = userSettings.savings_goal > 0 ? (saved / userSettings.savings_goal) * 100 : 0;
    var statusEl = document.getElementById('goalStatus');
    if (userSettings.savings_goal === 0) { statusEl.textContent = 'No goal set'; statusEl.style.color = 'rgba(255,255,255,0.4)'; }
    else if (pct >= 100) { statusEl.textContent = 'Achieved!'; statusEl.style.color = '#10b981'; }
    else if (pct >= 50) { statusEl.textContent = Math.round(pct) + '% there'; statusEl.style.color = '#f59e0b'; }
    else { statusEl.textContent = 'Behind target'; statusEl.style.color = '#ef4444'; }

    var now = new Date();
    var months = [], savingsData = [];
    for (var i = 5; i >= 0; i--) {
        var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        months.push(d.toLocaleString('default', { month: 'short' }));
        var monthSaved = expenses.filter(function(e) { return e.date.startsWith(key) && e.category === 'Savings'; }).reduce(function(s, e) { return s + e.amount; }, 0);
        savingsData.push(monthSaved);
    }

    if (savingsChart) savingsChart.destroy();
    var ctx = document.getElementById('savingsLineChart').getContext('2d');
    var sc = chartColors();
    var gradient = ctx.createLinearGradient(0, 0, 0, 320);
    gradient.addColorStop(0, isLight() ? 'rgba(16,185,129,0.2)' : 'rgba(16,185,129,0.15)');
    gradient.addColorStop(1, 'rgba(16,185,129,0)');

    savingsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: months,
            datasets: [
                { label: 'Saved', data: savingsData, borderColor: '#10b981', backgroundColor: gradient, fill: true, tension: 0.4, pointBackgroundColor: '#10b981', pointBorderColor: isLight() ? '#fff' : '#10b981', pointBorderWidth: isLight() ? 2 : 0, pointRadius: 6, pointHoverRadius: 8, borderWidth: 3 },
                { label: 'Goal', data: Array(6).fill(userSettings.savings_goal), borderColor: isLight() ? 'rgba(139,92,246,0.6)' : 'rgba(139,92,246,0.5)', borderDash: [6, 4], pointRadius: 0, borderWidth: 2, fill: false }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: sc.legendText, font: { family: 'Inter', weight: isLight() ? '500' : '400' }, usePointStyle: true } },
                tooltip: { backgroundColor: isLight() ? 'rgba(26,26,46,0.9)' : 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: 'rgba(255,255,255,0.8)', borderColor: isLight() ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12, cornerRadius: 10, titleFont: { family: 'Inter', weight: '600' }, bodyFont: { family: 'Inter' } }
            },
            scales: {
                y: { grid: { color: sc.grid }, ticks: { color: sc.tick } },
                x: { grid: { display: false }, ticks: { color: sc.text } }
            }
        }
    });
}

// CURRENCY
async function loadCurrencyPage() {
    populateCurrencySelects();
    await fetchRates();
    renderCurrencyChart();
}

function populateCurrencySelects() {
    var fromSel = document.getElementById('convertFrom');
    var toSel = document.getElementById('convertTo');
    fromSel.innerHTML = '';
    toSel.innerHTML = '';
    currencies.forEach(function(c) {
        var info = currencyInfo[c] || { flag: '\uD83D\uDCB1', name: c };
        var label = info.flag + ' ' + c + (info.name !== c ? ' - ' + info.name : '');
        var o1 = document.createElement('option');
        o1.value = c; o1.textContent = label;
        if (c === userSettings.currency) o1.selected = true;
        fromSel.appendChild(o1);
        var o2 = document.createElement('option');
        o2.value = c; o2.textContent = label;
        if (c === 'USD' && userSettings.currency !== 'USD') o2.selected = true;
        if (c === 'EUR' && userSettings.currency === 'USD') o2.selected = true;
        toSel.appendChild(o2);
    });
}

async function fetchRates() {
    try {
        var res = await fetch('https://api.exchangerate-api.com/v4/latest/' + userSettings.currency);
        exchangeRates = (await res.json()).rates || {};
    } catch (err) { exchangeRates = {}; }
}

function setupCurrencyConverter() {
    var amountEl = document.getElementById('convertAmount');
    var fromEl = document.getElementById('convertFrom');
    var toEl = document.getElementById('convertTo');

    function convert() {
        var amount = parseFloat(amountEl.value) || 0;
        var from = fromEl.value, to = toEl.value;
        if (!Object.keys(exchangeRates).length) { document.getElementById('convertResult').textContent = 'Rates unavailable'; return; }
        var result;
        if (from === userSettings.currency) { result = amount * (exchangeRates[to] || 1); }
        else { result = (amount / (exchangeRates[from] || 1)) * (exchangeRates[to] || 1); }
        document.getElementById('convertResult').textContent = result.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' ' + to;
        document.getElementById('rateInfo').textContent = amount > 0 ? '1 ' + from + ' = ' + (result / amount).toFixed(4) + ' ' + to + ' (updated live)' : '';
    }

    amountEl.addEventListener('input', convert);
    fromEl.addEventListener('change', async function() {
        try { var res = await fetch('https://api.exchangerate-api.com/v4/latest/' + fromEl.value); exchangeRates = (await res.json()).rates || {}; } catch(e){}
        convert();
    });
    toEl.addEventListener('change', convert);
    setTimeout(convert, 1000);
}

function renderCurrencyChart() {
    var compare = ['USD','EUR','GBP','NGN','KES','INR','BRL','JPY','AUD','CNY'].filter(function(c) { return c !== userSettings.currency; });
    var compareLabels = compare.map(function(c) { var info = currencyInfo[c] || { flag: '' }; return info.flag + ' ' + c; });
    document.getElementById('currencyCompareLabel').textContent = 'How much 1 ' + userSettings.currency + ' is worth in other currencies';
    var ccc = chartColors();
    if (currencyChart) currencyChart.destroy();
    currencyChart = new Chart(document.getElementById('currencyChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: compareLabels,
            datasets: [{ label: '1 ' + userSettings.currency + ' =', data: compare.map(function(c) { return exchangeRates[c] || 0; }), backgroundColor: isLight() ? ['rgba(16,185,129,0.75)','rgba(59,130,246,0.75)','rgba(139,92,246,0.75)','rgba(245,158,11,0.75)','rgba(236,72,153,0.75)','rgba(6,182,212,0.75)','rgba(249,115,22,0.75)','rgba(99,102,241,0.75)','rgba(20,184,166,0.75)','rgba(232,121,249,0.75)'] : ['#10b981','#3b82f6','#8b5cf6','#f59e0b','#ec4899','#06b6d4','#f97316','#6366f1','#14b8a6','#e879f9'], borderWidth: 0, borderRadius: 6, barThickness: 36 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: isLight() ? 'rgba(26,26,46,0.9)' : 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: 'rgba(255,255,255,0.8)', borderColor: isLight() ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12, cornerRadius: 10, titleFont: { family: 'Inter', weight: '600' }, bodyFont: { family: 'Inter' } }
            },
            scales: {
                x: { grid: { color: ccc.grid }, ticks: { color: ccc.tick } },
                y: { grid: { display: false }, ticks: { color: ccc.textStrong, font: { weight: '600', size: 12 } } }
            }
        }
    });
}

// ADVICE
function renderAdvice() {
    var grid = document.getElementById('adviceGrid');
    grid.innerHTML = '';
    var monthExp = currentMonthExpenses();
    var totalSpent = monthExp.reduce(function(s, e) { return s + e.amount; }, 0);
    var remaining = userSettings.income - totalSpent;
    var spendPct = userSettings.income > 0 ? (totalSpent / userSettings.income) * 100 : 0;
    var catTotals = {};
    monthExp.forEach(function(e) { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });

    var advice = [];

    if (userSettings.income === 0) advice.push({ type: 'info', icon: '\uD83D\uDCB5', title: 'Set Your Income', text: 'Add your monthly income in Savings to get personalized spending advice.' });
    else if (spendPct > 90) advice.push({ type: 'danger', icon: '\u26A0\uFE0F', title: 'Overspending Alert', text: 'You\'ve spent ' + Math.round(spendPct) + '% of your income this month. Look for expenses you can cut immediately.' });
    else if (spendPct > 70) advice.push({ type: 'warning', icon: '\uD83D\uDCA1', title: 'Watch Your Spending', text: 'You\'ve used ' + Math.round(spendPct) + '% of your income. Be mindful of non-essential purchases.' });
    else advice.push({ type: 'success', icon: '\u2705', title: 'Great Spending Habits', text: 'You\'ve only used ' + Math.round(spendPct) + '% of your income. You\'re on track!' });

    var saved = Math.max(0, remaining);
    if (saved >= userSettings.savings_goal) advice.push({ type: 'success', icon: '\uD83C\uDF89', title: 'Savings Goal Reached!', text: 'You\'ve saved ' + fmt(saved) + ', exceeding your goal of ' + fmt(userSettings.savings_goal) + '.' });
    else advice.push({ type: 'info', icon: '\uD83C\uDFAF', title: 'Savings Progress', text: 'You need ' + fmt(userSettings.savings_goal - saved) + ' more to hit your monthly goal.' });

    if (userSettings.income > 0) {
        if (((catTotals['Food'] || 0) / userSettings.income) * 100 > 25) advice.push({ type: 'warning', icon: '\uD83C\uDF54', title: 'Food Spending High', text: 'Food is ' + Math.round(((catTotals['Food'] || 0) / userSettings.income) * 100) + '% of income. Try meal prepping or buying in bulk.' });
        if (((catTotals['Entertainment'] || 0) / userSettings.income) * 100 > 15) advice.push({ type: 'warning', icon: '\uD83C\uDFAC', title: 'Entertainment Costs', text: Math.round(((catTotals['Entertainment'] || 0) / userSettings.income) * 100) + '% on entertainment. Look for free alternatives.' });
        if (((catTotals['Housing'] || 0) / userSettings.income) * 100 > 35) advice.push({ type: 'danger', icon: '\uD83C\uDFE0', title: 'Housing Too High', text: 'Housing is ' + Math.round(((catTotals['Housing'] || 0) / userSettings.income) * 100) + '% of income. Experts recommend under 30%.' });
    }
    if (catTotals['Subscriptions']) advice.push({ type: 'info', icon: '\uD83D\uDCF1', title: 'Review Subscriptions', text: fmt(catTotals['Subscriptions']) + ' in subscriptions. Are you using all of them?' });

    // Savings goals advice
    savingsGoals.forEach(function(goal) {
        if (goal.saved_amount >= goal.target_amount) {
            advice.push({ type: 'success', icon: '\uD83C\uDF89', title: goal.name + ' - Complete!', text: 'You\'ve saved enough for ' + goal.name + '. Congratulations!' });
        } else if (goal.monthly_contribution > 0) {
            var monthsLeft = Math.ceil((goal.target_amount - goal.saved_amount) / goal.monthly_contribution);
            advice.push({ type: 'info', icon: '\uD83D\uDCB0', title: 'Saving for ' + goal.name, text: fmt(goal.target_amount - goal.saved_amount) + ' to go. At ' + fmt(goal.monthly_contribution) + '/month, about ' + monthsLeft + ' month' + (monthsLeft === 1 ? '' : 's') + ' left.' });
        }
    });

    var needsCats = ['Housing','Food','Transport','Utilities','Health'];
    var wantsCats = ['Entertainment','Shopping','Subscriptions','Personal'];
    var needs = 0, wants = 0;
    needsCats.forEach(function(c) { needs += catTotals[c] || 0; });
    wantsCats.forEach(function(c) { wants += catTotals[c] || 0; });
    if (userSettings.income > 0) {
        var nPct = (needs / userSettings.income) * 100, wPct = (wants / userSettings.income) * 100;
        advice.push({ type: 'info', icon: '\uD83D\uDCCA', title: '50/30/20 Rule', text: 'Needs: ' + Math.round(nPct) + '% (50%) | Wants: ' + Math.round(wPct) + '% (30%) | Savings: ' + Math.round(100 - nPct - wPct) + '% (20%). ' + (nPct <= 50 && wPct <= 30 ? 'You\'re on track!' : 'Adjust spending to hit these targets.') });
    }

    if (monthExp.length === 0) advice.push({ type: 'info', icon: '\uD83D\uDCDD', title: 'Start Tracking', text: 'No expenses logged this month. Add some to get personalized advice.' });

    advice.forEach(function(a) {
        var card = document.createElement('div');
        card.className = 'advice-card ' + a.type;
        card.innerHTML = '<div class="advice-icon">' + a.icon + '</div><h3>' + a.title + '</h3><p>' + a.text + '</p>';
        grid.appendChild(card);
    });

    // Comfortable Living Calculator — based on current month spending
    var avgMonthly = totalSpent;

    var buffer = avgMonthly * 0.20;
    var comfortSavings = avgMonthly * 0.15;
    var comfortMonthly = avgMonthly + buffer + comfortSavings;
    var comfortYearly = comfortMonthly * 12;

    document.getElementById('comfortExpenses').textContent = fmt(avgMonthly);
    document.getElementById('comfortBuffer').textContent = fmt(buffer);
    document.getElementById('comfortSavings').textContent = fmt(comfortSavings);
    document.getElementById('comfortMonthly').textContent = fmt(comfortMonthly);
    document.getElementById('comfortYearly').textContent = fmt(comfortYearly);

    var note = '';
    if (avgMonthly === 0) {
        note = 'Add some expenses to see your comfortable living calculation.';
    } else if (userSettings.income >= comfortMonthly) {
        note = 'Your current income of ' + fmt(userSettings.income) + ' covers comfortable living. You\'re in great shape!';
    } else {
        note = 'You need ' + fmt(comfortMonthly - userSettings.income) + ' more per month to live comfortably based on your spending.';
    }
    document.getElementById('comfortNote').textContent = note;
}

// SEARCH, FILTER & EXPORT
// ACCOUNT PAGE
function renderAccount() {
    var meta = currentUser.user_metadata || {};
    var name = meta.full_name || meta.name || (currentUser.email ? currentUser.email.split('@')[0] : 'User');
    var email = currentUser.email || '-';
    var provider = currentUser.app_metadata && currentUser.app_metadata.provider ? currentUser.app_metadata.provider : 'email';

    // Profile picture
    var avatar = document.getElementById('accountAvatar');
    var savedPic = userSettings.avatar_url;
    if (savedPic) {
        avatar.textContent = '';
        avatar.style.backgroundImage = 'url(' + savedPic + ')';
    } else {
        avatar.textContent = name.charAt(0).toUpperCase();
        avatar.style.backgroundImage = '';
    }

    document.getElementById('avatarInput').onchange = function(ev) {
        var file = ev.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(e) {
            // Resize to 200x200
            var img = new Image();
            img.onload = function() {
                var canvas = document.createElement('canvas');
                canvas.width = 200;
                canvas.height = 200;
                var ctx = canvas.getContext('2d');
                var s = Math.min(img.width, img.height);
                var sx = (img.width - s) / 2;
                var sy = (img.height - s) / 2;
                ctx.drawImage(img, sx, sy, s, s, 0, 0, 200, 200);
                var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                updateUserSetting('avatar_url', dataUrl);
                avatar.textContent = '';
                avatar.style.backgroundImage = 'url(' + dataUrl + ')';
                // Also update sidebar avatar
                var sidebarAvatar = document.getElementById('userAvatar');
                sidebarAvatar.textContent = '';
                sidebarAvatar.style.backgroundImage = 'url(' + dataUrl + ')';
                sidebarAvatar.style.backgroundSize = 'cover';
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    };

    document.getElementById('accountName').textContent = name;

    // Avatar tap to preview
    var avatarEl = document.getElementById('accountAvatar');
    var previewOverlay = document.getElementById('avatarPreviewOverlay');
    var previewImg = document.getElementById('avatarPreviewImg');
    avatarEl.onclick = function() {
        var bg = avatarEl.style.backgroundImage;
        if (bg && bg !== 'none' && bg !== '') {
            previewImg.style.backgroundImage = bg;
            previewOverlay.classList.remove('hidden');
        }
    };
    previewOverlay.onclick = function() {
        previewOverlay.classList.add('hidden');
    };

    document.getElementById('accName').textContent = name;
    document.getElementById('accEmail').textContent = email;
    document.getElementById('accProvider').textContent = provider === 'google' ? 'Google OAuth' : 'Email & Password';
    document.getElementById('accJoined').textContent = new Date(userSettings.created_at || currentUser.created_at).toLocaleDateString('default', { year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('accCurrency').textContent = userSettings.currency || '-';
    document.getElementById('accIncome').textContent = fmt(userSettings.income);
    document.getElementById('accGoal').textContent = fmt(userSettings.savings_goal);
    updateTitheDisplay();

    // Adapt labels for mode
    var incLabel = document.getElementById('accIncomeLabel');
    var goalLabel = document.getElementById('accGoalLabel');
    var modeNameRow = document.getElementById('accModeNameRow');
    var modeNameLabel = document.getElementById('accModeNameLabel');
    var modeNameVal = document.getElementById('accModeName');
    var bizTypeRow = document.getElementById('accBizTypeRow');
    var bizTypeVal = document.getElementById('accBizType');
    if (accountMode === 'business') {
        if (incLabel) incLabel.textContent = 'Monthly Revenue';
        if (goalLabel) goalLabel.textContent = 'Budget Target';
        if (modeNameRow) modeNameRow.style.display = '';
        if (modeNameLabel) modeNameLabel.textContent = 'Business Name';
        if (modeNameVal) modeNameVal.textContent = userSettings.company_name || '-';
        if (bizTypeRow) bizTypeRow.style.display = '';
        if (bizTypeVal) bizTypeVal.textContent = userSettings.biz_type || '-';
    } else if (accountMode === 'family') {
        if (incLabel) incLabel.textContent = 'Household Budget';
        if (goalLabel) goalLabel.textContent = 'Family Goal';
        if (modeNameRow) modeNameRow.style.display = '';
        if (modeNameLabel) modeNameLabel.textContent = 'Family Name';
        if (modeNameVal) modeNameVal.textContent = userSettings.family_name || '-';
        if (bizTypeRow) bizTypeRow.style.display = 'none';
    } else {
        if (incLabel) incLabel.textContent = 'Monthly Income';
        if (goalLabel) goalLabel.textContent = 'Savings Goal';
        if (modeNameRow) modeNameRow.style.display = 'none';
        if (bizTypeRow) bizTypeRow.style.display = 'none';
    }

    // Edit mode name (business/family)
    document.getElementById('changeModeName').onclick = async function() {
        var currentName = accountMode === 'business'
            ? (userSettings.company_name || '')
            : (userSettings.family_name || '');
        var label = accountMode === 'business' ? 'Business' : 'Family';
        var newName = prompt('Enter new ' + label + ' name:', currentName);
        if (!newName || !newName.trim()) return;
        newName = newName.trim();
        if (accountMode === 'business') {
            await updateUserSetting('company_name', newName);
        } else {
            await updateUserSetting('family_name', newName);
        }
        modeNameVal.textContent = newName;
        applyMode(accountMode);
    };

    // Currency change button
    document.getElementById('changeCurrencyBtn').onclick = function() {
        var sel = document.getElementById('newCurrencySelect');
        for (var i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === userSettings.currency) {
                sel.selectedIndex = i;
                break;
            }
        }
        document.getElementById('changeCurrencyModal').classList.remove('hidden');
    };
    document.getElementById('closeChangeCurrencyModal').onclick = function() {
        document.getElementById('changeCurrencyModal').classList.add('hidden');
    };
    document.getElementById('changeCurrencyForm').onsubmit = async function(e) {
        e.preventDefault();
        var newCurrency = document.getElementById('newCurrencySelect').value;
        userSettings.currency = newCurrency;
        var currencyUpdate;
        if (accountMode === 'business') currencyUpdate = { biz_currency: newCurrency };
        else if (accountMode === 'family') currencyUpdate = { fam_currency: newCurrency };
        else currencyUpdate = { currency: newCurrency };
        await supabase.from('user_settings').update(currencyUpdate).eq('user_id', currentUser.id);
        document.getElementById('changeCurrencyModal').classList.add('hidden');
        document.getElementById('accCurrency').textContent = newCurrency;
        loadExpenses();
    };

    var cats = {};
    expenses.forEach(function(e) { cats[e.category] = true; });
    document.getElementById('accTotalExpenses').textContent = expenses.length;
    document.getElementById('accCategories').textContent = Object.keys(cats).length;
    document.getElementById('accGoalsCount').textContent = savingsGoals.length;

    renderAchievements();

    document.getElementById('accLogout').onclick = async function() {
        await supabase.auth.signOut();
        window.location.href = 'index.html';
    };

    document.getElementById('accDeleteData').onclick = async function() {
        if (!confirm('This will permanently delete ALL your expenses, savings goals, and settings. Are you sure?')) return;
        if (!confirm('This cannot be undone. Type OK to confirm.')) return;
        auditLog('account_data_deleted', 'User deleted all data');
        await supabase.from('expenses').delete().eq('user_id', currentUser.id);
        await supabase.from('savings_goals').delete().eq('user_id', currentUser.id);
        await supabase.from('custom_categories').delete().eq('user_id', currentUser.id);
        await supabase.from('family_goals').delete().eq('user_id', currentUser.id);
        await supabase.from('family_chores').delete().eq('user_id', currentUser.id);
        await supabase.from('family_members').delete().eq('user_id', currentUser.id);
        await supabase.from('user_settings').delete().eq('user_id', currentUser.id);
        // Clean up all localStorage data
        Object.keys(localStorage).forEach(function(key) {
            if (key.startsWith('bw-')) localStorage.removeItem(key);
        });
        await supabase.auth.signOut();
        window.location.href = 'index.html';
    };

    // Change Name
    document.getElementById('changeNameBtn').onclick = async function() {
        var newName = prompt('Enter your new name:', document.getElementById('accName').textContent);
        if (!newName || !newName.trim()) return;
        newName = newName.trim();
        var { error } = await supabase.auth.updateUser({ data: { full_name: newName } });
        if (error) { alert('Error updating name: ' + error.message); return; }
        document.getElementById('accName').textContent = newName;
        document.getElementById('accountName').textContent = newName;
        var sidebarName = document.querySelector('.user-name');
        if (sidebarName) sidebarName.textContent = newName;
        showUndoToast('Name updated successfully');
    };

    // Change Email
    document.getElementById('changeEmailBtn').onclick = async function() {
        var newEmail = prompt('Enter your new email address:');
        if (!newEmail || !newEmail.trim()) return;
        newEmail = newEmail.trim();
        var { error } = await supabase.auth.updateUser({ email: newEmail });
        if (error) { alert('Error updating email: ' + error.message); return; }
        showUndoToast('Confirmation email sent to ' + newEmail);
    };

    // Change Password — secure modal instead of prompt()
    document.getElementById('accChangePassword').onclick = function() {
        document.getElementById('changePasswordModal').classList.remove('hidden');
    };
    document.getElementById('closePasswordModal').onclick = function() {
        document.getElementById('changePasswordModal').classList.add('hidden');
        document.getElementById('newPasswordInput').value = '';
        document.getElementById('confirmPasswordInput').value = '';
    };
    document.getElementById('changePasswordForm').onsubmit = async function(e) {
        e.preventDefault();
        var newPw = document.getElementById('newPasswordInput').value;
        var confirmPw = document.getElementById('confirmPasswordInput').value;
        if (newPw.length < 6) { alert('Password must be at least 6 characters.'); return; }
        if (newPw !== confirmPw) { alert('Passwords do not match.'); return; }
        var { error } = await supabase.auth.updateUser({ password: newPw });
        if (error) { alert('Error updating password: ' + error.message); return; }
        auditLog('password_changed', 'Password updated');
        document.getElementById('changePasswordModal').classList.add('hidden');
        document.getElementById('newPasswordInput').value = '';
        document.getElementById('confirmPasswordInput').value = '';
        showUndoToast('Password updated successfully');
    };

    // Backup All Data
    document.getElementById('accBackup').onclick = async function() {
        try {
            var userId = currentUser.id;
            var results = await Promise.all([
                supabase.from('user_settings').select('*').eq('user_id', userId),
                supabase.from('expenses').select('*').eq('user_id', userId),
                supabase.from('savings_goals').select('*').eq('user_id', userId),
                supabase.from('custom_categories').select('*').eq('user_id', userId),
                supabase.from('family_members').select('*').eq('user_id', userId),
                supabase.from('family_chores').select('*').eq('user_id', userId),
                supabase.from('family_goals').select('*').eq('user_id', userId),
                supabase.from('family_goal_contributions').select('*').eq('user_id', userId)
            ]);
            var backup = {
                version: 1,
                timestamp: new Date().toISOString(),
                user_id: userId,
                user_settings: results[0].data || [],
                expenses: results[1].data || [],
                savings_goals: results[2].data || [],
                custom_categories: results[3].data || [],
                family_members: results[4].data || [],
                family_chores: results[5].data || [],
                family_goals: results[6].data || [],
                family_goal_contributions: results[7].data || []
            };
            var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'budgetwise-backup-' + new Date().toISOString().split('T')[0] + '.json';
            a.click();
            URL.revokeObjectURL(url);
            showUndoToast('Backup downloaded successfully');
        } catch (err) {
            alert('Backup failed: ' + err.message);
        }
    };

    // Restore from Backup
    var restoreFileInput = document.getElementById('restoreFile');
    document.getElementById('accRestore').onclick = function() {
        restoreFileInput.click();
    };
    restoreFileInput.onchange = function(ev) {
        var file = ev.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = async function(e) {
            try {
                var backup = JSON.parse(e.target.result);
                if (!backup.version || !backup.expenses) {
                    alert('Invalid backup file. Missing required data.');
                    return;
                }
                if (!confirm('This will replace all your current data with the backup from ' + (backup.timestamp ? new Date(backup.timestamp).toLocaleDateString() : 'unknown date') + '. Continue?')) return;

                var userId = currentUser.id;

                // Delete existing data
                await supabase.from('expenses').delete().eq('user_id', userId);
                await supabase.from('savings_goals').delete().eq('user_id', userId);
                await supabase.from('custom_categories').delete().eq('user_id', userId);
                await supabase.from('family_goals').delete().eq('user_id', userId);
                await supabase.from('family_chores').delete().eq('user_id', userId);
                await supabase.from('family_members').delete().eq('user_id', userId);

                // Restore user_settings
                if (backup.user_settings && backup.user_settings.length > 0) {
                    var settings = backup.user_settings[0];
                    delete settings.id;
                    settings.user_id = userId;
                    await supabase.from('user_settings').upsert(settings, { onConflict: 'user_id' });
                }

                // Restore expenses
                if (backup.expenses && backup.expenses.length > 0) {
                    var exps = backup.expenses.map(function(exp) {
                        delete exp.id;
                        exp.user_id = userId;
                        return exp;
                    });
                    await supabase.from('expenses').insert(exps);
                }

                // Restore savings_goals
                if (backup.savings_goals && backup.savings_goals.length > 0) {
                    var goals = backup.savings_goals.map(function(g) {
                        delete g.id;
                        g.user_id = userId;
                        return g;
                    });
                    await supabase.from('savings_goals').insert(goals);
                }

                // Restore custom_categories
                if (backup.custom_categories && backup.custom_categories.length > 0) {
                    var cats = backup.custom_categories.map(function(c) {
                        delete c.id;
                        c.user_id = userId;
                        return c;
                    });
                    await supabase.from('custom_categories').insert(cats);
                }

                // Restore family_members
                if (backup.family_members && backup.family_members.length > 0) {
                    var members = backup.family_members.map(function(m) {
                        delete m.id;
                        m.user_id = userId;
                        return m;
                    });
                    await supabase.from('family_members').insert(members);
                }

                // Restore family_chores
                if (backup.family_chores && backup.family_chores.length > 0) {
                    var chores = backup.family_chores.map(function(ch) {
                        delete ch.id;
                        ch.user_id = userId;
                        return ch;
                    });
                    await supabase.from('family_chores').insert(chores);
                }

                // Restore family_goals
                if (backup.family_goals && backup.family_goals.length > 0) {
                    var fgoals = backup.family_goals.map(function(fg) {
                        delete fg.id;
                        fg.user_id = userId;
                        return fg;
                    });
                    await supabase.from('family_goals').insert(fgoals);
                }

                showUndoToast('Data restored successfully');
                setTimeout(function() { window.location.reload(); }, 1500);
            } catch (err) {
                alert('Restore failed: ' + err.message);
            }
        };
        reader.readAsText(file);
        restoreFileInput.value = '';
    };
}

function setupSearchAndExport() {
    document.getElementById('expenseSearch').addEventListener('input', renderAllExpenses);
    document.getElementById('categoryFilter').addEventListener('change', renderAllExpenses);
    document.getElementById('exportCSV').addEventListener('click', exportToCSV);
    document.getElementById('exportPDF').addEventListener('click', exportToPDF);
}

function csvSafe(val) {
    var s = String(val);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
}

function exportToCSV() {
    if (expenses.length === 0) { alert('No expenses to export.'); return; }
    var csv = 'Date,Category,Description,Amount,Recurring\n';
    expenses.forEach(function(e) {
        csv += csvSafe(e.date) + ',' + csvSafe(e.category) + ',' + csvSafe(e.description) + ',' + e.amount + ',' + csvSafe(e.recurring) + '\n';
    });
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'budgetwise-expenses-' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
}

function exportToPDF() {
    if (expenses.length === 0) { alert('No expenses to export.'); return; }
    var sym = getCurrencySymbol();
    var totalSpent = expenses.reduce(function(s, e) { return s + e.amount; }, 0);
    var catTotals = {};
    expenses.forEach(function(e) {
        catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
    });
    var dates = expenses.map(function(e) { return e.date; }).sort();
    var dateRange = dates[0] + ' to ' + dates[dates.length - 1];

    var catRows = '';
    Object.keys(catTotals).sort(function(a, b) { return catTotals[b] - catTotals[a]; }).forEach(function(cat) {
        var pct = ((catTotals[cat] / totalSpent) * 100).toFixed(1);
        catRows += '<tr><td>' + escapeHtml(cat) + '</td><td style="text-align:right;">' + sym + catTotals[cat].toFixed(2) + '</td><td style="text-align:right;">' + pct + '%</td></tr>';
    });

    var expRows = '';
    expenses.slice().sort(function(a, b) { return a.date < b.date ? 1 : -1; }).forEach(function(e) {
        expRows += '<tr><td>' + e.date + '</td><td>' + escapeHtml(e.category) + '</td><td>' + escapeHtml(e.description) + '</td><td style="text-align:right;">' + sym + Number(e.amount).toFixed(2) + '</td></tr>';
    });

    var html = '<!DOCTYPE html><html><head><title>BudgetWise Expense Report</title><style>' +
        'body{font-family:Inter,Arial,sans-serif;color:#111;margin:40px;line-height:1.5;}' +
        'h1{font-size:22px;margin-bottom:4px;}' +
        'h2{font-size:16px;margin-top:28px;margin-bottom:8px;border-bottom:2px solid #10b981;padding-bottom:4px;}' +
        '.subtitle{color:#666;font-size:13px;margin-bottom:20px;}' +
        '.summary{display:flex;gap:30px;margin-bottom:20px;}' +
        '.summary-item{background:#f0fdf4;padding:12px 18px;border-radius:8px;}' +
        '.summary-item .label{font-size:11px;color:#666;text-transform:uppercase;}' +
        '.summary-item .value{font-size:20px;font-weight:700;color:#111;}' +
        'table{width:100%;border-collapse:collapse;font-size:13px;}' +
        'th{text-align:left;padding:8px 10px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-weight:600;}' +
        'td{padding:7px 10px;border-bottom:1px solid #e2e8f0;}' +
        'tr:nth-child(even){background:#fafafa;}' +
        '@media print{body{margin:20px;}}</style></head><body>' +
        '<h1>BudgetWise Expense Report</h1>' +
        '<p class="subtitle">Period: ' + dateRange + ' &bull; Generated: ' + new Date().toLocaleDateString() + '</p>' +
        '<div class="summary">' +
        '<div class="summary-item"><div class="label">Total Spent</div><div class="value">' + sym + totalSpent.toFixed(2) + '</div></div>' +
        '<div class="summary-item"><div class="label">Transactions</div><div class="value">' + expenses.length + '</div></div>' +
        '<div class="summary-item"><div class="label">Income</div><div class="value">' + sym + Number(userSettings.income).toFixed(2) + '</div></div>' +
        '</div>' +
        '<h2>Category Breakdown</h2>' +
        '<table><thead><tr><th>Category</th><th style="text-align:right;">Amount</th><th style="text-align:right;">%</th></tr></thead><tbody>' + catRows + '</tbody></table>' +
        '<h2>All Expenses</h2>' +
        '<table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th style="text-align:right;">Amount</th></tr></thead><tbody>' + expRows + '</tbody></table>' +
        '</body></html>';

    var win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    setTimeout(function() { win.print(); }, 500);
}

// RECEIPT SCANNING
function resizeImageForOCR(file, maxWidth) {
    maxWidth = maxWidth || 800;
    return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() {
            var w = img.width, h = img.height;
            var scale = Math.min(1, maxWidth / Math.max(w, h));
            var canvas = document.createElement('canvas');
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            // Convert to grayscale to reduce memory + improve OCR accuracy
            var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var d = imageData.data;
            for (var i = 0; i < d.length; i += 4) {
                var gray = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
                d[i] = d[i+1] = d[i+2] = gray;
            }
            ctx.putImageData(imageData, 0, 0);
            canvas.toBlob(function(blob) {
                URL.revokeObjectURL(img.src);
                resolve(blob);
            }, 'image/jpeg', 0.6);
        };
        img.onerror = function() { URL.revokeObjectURL(img.src); resolve(file); };
        img.src = URL.createObjectURL(file);
    });
}

function parseReceiptText(text) {
    var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    var result = { amount: '', description: '', category: 'Other' };

    // Find the largest number with a decimal as the likely total
    var amounts = [];
    var amountRegex = /[\$\€\£\₦R]?\s*(\d{1,}[.,]\d{2})\b/g;
    var match;
    while ((match = amountRegex.exec(text)) !== null) {
        var val = parseFloat(match[1].replace(',', '.'));
        if (!isNaN(val) && val > 0) amounts.push(val);
    }
    if (amounts.length > 0) {
        result.amount = Math.max.apply(null, amounts).toFixed(2);
    }

    // First meaningful line as description (store name)
    for (var i = 0; i < Math.min(lines.length, 5); i++) {
        var line = lines[i].replace(/[^a-zA-Z0-9\s&\-']/g, '').trim();
        if (line.length > 2 && !/^\d+$/.test(line)) {
            result.description = line;
            break;
        }
    }

    // Category mapping from keywords
    var lower = text.toLowerCase();
    var catMap = {
        'Food': ['grocery', 'groceries', 'supermarket', 'food', 'restaurant', 'cafe', 'coffee', 'bakery', 'pizza', 'burger', 'spar', 'woolworths', 'checkers', 'pick n pay', 'shoprite', 'walmart', 'costco', 'aldi', 'lidl', 'tesco', 'mcdonald', 'starbucks', 'kfc'],
        'Transport': ['uber', 'lyft', 'taxi', 'fuel', 'petrol', 'gas station', 'parking', 'toll', 'transit', 'bus', 'train', 'shell', 'engen', 'bp', 'caltex', 'sasol'],
        'Health': ['pharmacy', 'chemist', 'doctor', 'hospital', 'clinic', 'medical', 'dental', 'clicks', 'dischem', 'dis-chem', 'cvs', 'walgreens'],
        'Shopping': ['clothing', 'fashion', 'shoes', 'mall', 'store', 'amazon', 'takealot', 'mr price', 'edgars', 'jet', 'ackermans', 'pep'],
        'Entertainment': ['cinema', 'movie', 'theatre', 'theater', 'concert', 'game', 'netflix', 'spotify', 'dstv', 'showmax'],
        'Utilities': ['electric', 'water', 'internet', 'wifi', 'telkom', 'vodacom', 'mtn', 'cell c', 'airtel', 'prepaid'],
        'Housing': ['rent', 'mortgage', 'lease', 'property'],
        'Education': ['school', 'university', 'college', 'book', 'tuition', 'course'],
        'Subscriptions': ['subscription', 'membership', 'monthly', 'annual', 'premium'],
        'Personal': ['salon', 'barber', 'spa', 'beauty', 'gym', 'fitness']
    };
    for (var cat in catMap) {
        for (var j = 0; j < catMap[cat].length; j++) {
            if (lower.indexOf(catMap[cat][j]) !== -1) {
                result.category = cat;
                return result;
            }
        }
    }
    return result;
}

function setupReceiptScanning() {
    var scanBtn = document.getElementById('scanReceiptBtn');
    var receiptInput = document.getElementById('receiptInput');
    var scanModal = document.getElementById('scanResultModal');
    var closeScanModal = document.getElementById('closeScanModal');
    if (!scanBtn || !receiptInput) return;

    scanBtn.addEventListener('click', function() {
        receiptInput.click();
    });

    closeScanModal.addEventListener('click', function() {
        scanModal.classList.add('hidden');
    });

    receiptInput.addEventListener('change', async function(ev) {
        var file = ev.target.files[0];
        if (!file) return;
        receiptInput.value = '';

        // Show loading
        scanBtn.disabled = true;
        scanBtn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/></svg> Scanning...';

        try {
            // Show preview
            var preview = document.getElementById('scanPreview');
            var imgUrl = URL.createObjectURL(file);
            preview.innerHTML = '<img src="' + imgUrl + '" style="max-width:100%;border-radius:8px;">';

            // Resize + grayscale to reduce memory
            var resized = await resizeImageForOCR(file, 800);

            // Lazy-load Tesseract.js only when needed
            var parsed = { amount: '', description: '', category: 'Other' };
            try {
                if (typeof Tesseract === 'undefined') {
                    await new Promise(function(resolve, reject) {
                        var s = document.createElement('script');
                        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
                        s.onload = resolve;
                        s.onerror = function() { reject(new Error('Failed to load OCR library')); };
                        document.head.appendChild(s);
                    });
                }
                var ocrWorker = await Tesseract.createWorker('eng');
                var result = await ocrWorker.recognize(resized);
                await ocrWorker.terminate();
                parsed = parseReceiptText(result.data.text);
            } catch (ocrErr) {
                console.warn('OCR failed, opening manual entry:', ocrErr.message);
            }

            // Populate scan category dropdown
            var scanCatSelect = document.getElementById('scanCategory');
            scanCatSelect.innerHTML = '';
            var cats = ['Housing', 'Food', 'Transport', 'Utilities', 'Entertainment', 'Shopping', 'Health', 'Education', 'Subscriptions', 'Personal', 'Savings', 'Other'];
            if (customCategories && customCategories.length > 0) {
                customCategories.forEach(function(cc) { cats.push(cc.name); });
            }
            cats.forEach(function(c) {
                var opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                if (c === parsed.category) opt.selected = true;
                scanCatSelect.appendChild(opt);
            });

            document.getElementById('scanAmount').value = parsed.amount;
            document.getElementById('scanDescription').value = parsed.description;

            // Always show modal — OCR-filled or manual entry
            scanModal.classList.remove('hidden');
            if (!parsed.amount && !parsed.description) {
                showUndoToast('Could not read receipt — enter details manually');
            }
        } catch (err) {
            alert('Scan error: ' + err.message);
        } finally {
            scanBtn.disabled = false;
            scanBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/></svg> Scan';
        }
    });

    document.getElementById('scanAddExpense').addEventListener('click', async function() {
        var amount = parseFloat(document.getElementById('scanAmount').value);
        if (!amount || amount <= 0) { alert('Please enter a valid amount.'); return; }
        var description = document.getElementById('scanDescription').value.trim() || 'Scanned receipt';
        var category = document.getElementById('scanCategory').value;

        var expense = {
            user_id: currentUser.id,
            category: category,
            description: description,
            amount: amount,
            date: new Date().toISOString().split('T')[0],
            recurring: 'no',
            account_mode: accountMode
        };
        if (accountMode === 'family' && activeGroupId) {
            expense.group_id = activeGroupId;
            if (myFamilyRole === 'kid') {
                await supabase.from('family_pending').insert({
                    group_id: activeGroupId,
                    requested_by: currentUser.id,
                    requester_name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Member',
                    action: 'add_expense',
                    payload: expense
                });
                scanModal.classList.add('hidden');
                showUndoToast('Expense submitted for parent approval');
                loadPendingApprovals();
                return;
            }
        }
        await supabase.from('expenses').insert(expense);
        notifyExpenseAdded(expense);
        scanModal.classList.add('hidden');
        loadExpenses();
        showUndoToast('Expense added from receipt');
    });
}

// SPENDING TRENDS
function renderTrendChart() {
    var now = new Date();
    var months = [], spentData = [], savedData = [], monthKeys = [];
    var tc = chartColors();

    for (var i = 5; i >= 0; i--) {
        var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        months.push(d.toLocaleString('default', { month: 'short' }));
        monthKeys.push({ key: key, label: d.toLocaleString('default', { month: 'long', year: 'numeric' }) });
        var monthTotal = expenses.filter(function(e) { return e.date.startsWith(key); }).reduce(function(s, e) { return s + e.amount; }, 0);
        spentData.push(monthTotal);
        savedData.push(Math.max(0, userSettings.income - monthTotal));
    }

    if (trendChart) trendChart.destroy();
    var ctx = document.getElementById('trendChart').getContext('2d');
    var spentGrad = ctx.createLinearGradient(0, 0, 0, 300);
    spentGrad.addColorStop(0, 'rgba(239,68,68,0.15)');
    spentGrad.addColorStop(1, 'rgba(239,68,68,0)');
    var savedGrad = ctx.createLinearGradient(0, 0, 0, 300);
    savedGrad.addColorStop(0, 'rgba(16,185,129,0.15)');
    savedGrad.addColorStop(1, 'rgba(16,185,129,0)');

    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: months,
            datasets: [
                { label: 'Spent', data: spentData, borderColor: '#ef4444', backgroundColor: spentGrad, fill: true, tension: 0.4, pointBackgroundColor: '#ef4444', pointBorderColor: isLight() ? '#fff' : '#ef4444', pointBorderWidth: isLight() ? 2 : 0, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2.5 },
                { label: 'Saved', data: savedData, borderColor: '#10b981', backgroundColor: savedGrad, fill: true, tension: 0.4, pointBackgroundColor: '#10b981', pointBorderColor: isLight() ? '#fff' : '#10b981', pointBorderWidth: isLight() ? 2 : 0, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2.5 },
                { label: 'Income', data: Array(6).fill(userSettings.income), borderColor: 'rgba(99,102,241,0.5)', borderDash: [6, 4], pointRadius: 0, borderWidth: 2, fill: false }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            onClick: function(e, elements) {
                if (elements.length > 0) {
                    var idx = elements[0].index;
                    var mk = monthKeys[idx];
                    showDrillDown('Daily Breakdown - ' + mk.label, mk.key);
                }
            },
            plugins: {
                legend: { labels: { color: tc.legendText, font: { family: 'Inter', weight: isLight() ? '500' : '400' }, usePointStyle: true, padding: 16 } },
                tooltip: { backgroundColor: isLight() ? 'rgba(26,26,46,0.9)' : 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: 'rgba(255,255,255,0.8)', borderColor: isLight() ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12, cornerRadius: 10 }
            },
            scales: {
                y: { grid: { color: tc.grid }, ticks: { color: tc.tick } },
                x: { grid: { display: false }, ticks: { color: tc.text } }
            }
        }
    });
}

// CONFETTI
function fireConfetti() {
    var canvas = document.getElementById('confettiCanvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    var ctx = canvas.getContext('2d');
    var particles = [];
    var colors = ['#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#f97316', '#22d3ee'];

    for (var i = 0; i < 150; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            w: Math.random() * 10 + 5,
            h: Math.random() * 6 + 3,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 4,
            vy: Math.random() * 3 + 2,
            rot: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 10,
            opacity: 1
        });
    }

    var frame = 0;
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        frame++;
        var alive = false;
        particles.forEach(function(p) {
            if (p.opacity <= 0) return;
            alive = true;
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.05;
            p.rot += p.rotSpeed;
            if (frame > 60) p.opacity -= 0.01;
            ctx.save();
            ctx.globalAlpha = Math.max(0, p.opacity);
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot * Math.PI / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        });
        if (alive) requestAnimationFrame(animate);
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    animate();
}

// CUSTOM CATEGORIES
var defaultCategories = ['Housing','Food','Transport','Utilities','Entertainment','Shopping','Health','Education','Subscriptions','Personal','Savings','Other'];

async function loadCustomCategories() {
    var result = await supabase
        .from('custom_categories')
        .select('*')
        .eq('user_id', currentUser.id)
        .eq('account_mode', accountMode)
        .order('created_at', { ascending: true });
    customCategories = result.data || [];
    // Add custom colors to categoryColors
    customCategories.forEach(function(cat) {
        categoryColors[cat.name] = cat.color;
    });
    updateCategorySelects();
}

function updateCategorySelects() {
    var selects = document.querySelectorAll('#expCategory, #categoryFilter');
    selects.forEach(function(sel) {
        var isFilter = sel.id === 'categoryFilter';
        var currentVal = sel.value;
        // Keep first option(s)
        var firstOpt = sel.querySelector('option');
        sel.innerHTML = '';
        sel.appendChild(firstOpt);
        // Add default categories
        defaultCategories.forEach(function(cat) {
            var opt = document.createElement('option');
            opt.value = cat;
            opt.textContent = cat;
            sel.appendChild(opt);
        });
        // Add custom categories
        customCategories.forEach(function(cat) {
            var opt = document.createElement('option');
            opt.value = cat.name;
            opt.textContent = cat.name + ' *';
            sel.appendChild(opt);
        });
        if (currentVal) sel.value = currentVal;
    });
}

function setupCustomCategories() {
    document.getElementById('manageCatsBtn').addEventListener('click', function() {
        renderCategoryList();
        document.getElementById('categoryModal').classList.remove('hidden');
    });
    document.getElementById('closeCategoryModal').addEventListener('click', function() {
        document.getElementById('categoryModal').classList.add('hidden');
    });
    document.getElementById('addCategoryForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var name = document.getElementById('newCatName').value.trim();
        var color = document.getElementById('newCatColor').value;
        if (!name) return;
        await supabase.from('custom_categories').insert({
            user_id: currentUser.id,
            name: name,
            color: color,
            account_mode: accountMode
        });
        document.getElementById('newCatName').value = '';
        loadCustomCategories();
        renderCategoryList();
    });
}

function renderCategoryList() {
    var container = document.getElementById('customCatList');
    container.innerHTML = '';
    // Show default categories
    defaultCategories.forEach(function(cat) {
        var item = document.createElement('div');
        item.className = 'custom-cat-item';
        item.innerHTML = '<div class="cat-color-dot" style="background:' + (categoryColors[cat] || '#6b7280') + '"></div><span>' + cat + '</span><span class="badge-default">default</span>';
        container.appendChild(item);
    });
    // Show custom categories
    customCategories.forEach(function(cat) {
        var item = document.createElement('div');
        item.className = 'custom-cat-item';
        item.innerHTML = '<div class="cat-color-dot" style="background:' + cat.color + '"></div><span>' + escapeHtml(cat.name) + '</span><button class="btn-delete" data-id="' + cat.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>';
        container.appendChild(item);
    });
    // Attach delete
    container.querySelectorAll('.btn-delete').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            await supabase.from('custom_categories').delete().eq('id', btn.dataset.id);
            loadCustomCategories();
            renderCategoryList();
        });
    });
}

// DRILL-DOWN (click charts for daily detail)
function setupDrillDown() {
    document.getElementById('closeDrillModal').addEventListener('click', function() {
        document.getElementById('drillModal').classList.add('hidden');
    });
}

function showDrillDown(title, monthKey) {
    var monthExp = expenses.filter(function(e) { return e.date.startsWith(monthKey); });
    // Group by day
    var days = {};
    monthExp.forEach(function(e) {
        if (!days[e.date]) days[e.date] = [];
        days[e.date].push(e);
    });

    var content = document.getElementById('drillContent');
    document.getElementById('drillTitle').textContent = title;
    content.innerHTML = '';

    var sortedDays = Object.keys(days).sort().reverse();

    if (sortedDays.length === 0) {
        content.innerHTML = '<p style="color:rgba(255,255,255,0.3);text-align:center;padding:20px;">No expenses this month.</p>';
        document.getElementById('drillModal').classList.remove('hidden');
        return;
    }

    var list = document.createElement('div');
    list.className = 'drill-list';

    sortedDays.forEach(function(day) {
        var dayTotal = days[day].reduce(function(s, e) { return s + e.amount; }, 0);
        var dayDiv = document.createElement('div');
        dayDiv.className = 'drill-day';

        var header = '<div class="drill-day-header"><strong>' + new Date(day + 'T00:00:00').toLocaleDateString('default', { weekday: 'short', day: 'numeric', month: 'short' }) + '</strong><span>' + fmt(dayTotal) + '</span></div>';
        var items = '<div class="drill-day-items">';
        days[day].forEach(function(e) {
            items += '<div class="drill-item"><span>' + escapeHtml(e.description) + ' <span class="category-badge" style="background:' + (categoryColors[e.category] || '#6b7280') + '20;color:' + (categoryColors[e.category] || '#6b7280') + ';font-size:0.68rem;padding:2px 6px;">' + e.category + '</span></span><span class="drill-amount">' + fmt(e.amount) + '</span></div>';
        });
        items += '</div>';

        dayDiv.innerHTML = header + items;
        list.appendChild(dayDiv);
    });

    content.appendChild(list);
    document.getElementById('drillModal').classList.remove('hidden');
}

// =============================================
// FEATURE: Animated Number Counters
// =============================================
function animateCounter(el, target, prefix) {
    prefix = prefix || '';
    var start = 0;
    var duration = 800;
    var startTime = null;
    function step(timestamp) {
        if (!startTime) startTime = timestamp;
        var progress = Math.min((timestamp - startTime) / duration, 1);
        var eased = 1 - Math.pow(1 - progress, 3);
        var current = start + (target - start) * eased;
        el.textContent = prefix + Number(current).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (progress < 1) requestAnimationFrame(step);
    }
    if (target === 0) { el.textContent = prefix + '0.00'; return; }
    requestAnimationFrame(step);
}

function animateStatCounters() {
    var sym = { ZAR: 'R', USD: '$', EUR: '\u20AC', GBP: '\u00A3', NGN: '\u20A6', KES: 'KSh', GHS: 'GH\u20B5', INR: '\u20B9', BRL: 'R$', JPY: '\u00A5', AUD: 'A$', CAD: 'C$', CNY: '\u00A5', BWP: 'P', MZN: 'MT' };
    var prefix = sym[userSettings.currency] || userSettings.currency + ' ';
    var monthExp = currentMonthExpenses();
    var totalSpent = monthExp.reduce(function(s, e) { return s + e.amount; }, 0);
    var effectiveIncome = (accountMode === 'family' && activeGroupId) ? getFamilyJointIncome() : userSettings.income;
    var remaining = effectiveIncome - totalSpent;
    var saved = monthSavingsTotal();
    animateCounter(document.getElementById('statIncome'), effectiveIncome, prefix);
    animateCounter(document.getElementById('statSpent'), totalSpent, prefix);
    animateCounter(document.getElementById('statRemaining'), remaining, prefix);
    animateCounter(document.getElementById('statSaved'), saved, prefix);
    renderIncomeBreakdown(effectiveIncome, prefix);
}

// Phase 2: Joint vs Individual income breakdown on overview
function renderIncomeBreakdown(jointTotal, prefix) {
    var el = document.getElementById('familyIncomeBreakdown');
    if (!el) return;
    if (accountMode !== 'family' || !activeGroupId || familyLinkMembers.length <= 1) {
        el.style.display = 'none';
        return;
    }
    var listEl = document.getElementById('incomeBreakdownList');
    if (!listEl) return;
    var html = '';
    familyLinkMembers.forEach(function(link) {
        var contrib = Number(link.income_contribution) || 0;
        var pct = jointTotal > 0 ? Math.round((contrib / jointTotal) * 100) : 0;
        var roleColor = link.role === 'owner' ? '#8b5cf6' : link.role === 'parent' ? '#3b82f6' : '#f59e0b';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
                '<span style="width:8px;height:8px;border-radius:50%;background:' + roleColor + ';display:inline-block;"></span>' +
                '<span style="color:var(--text-primary);font-weight:500;">' + escapeHtml(link.display_name) + '</span>' +
                '<span style="font-size:0.7rem;color:var(--text-secondary);">(' + (link.role || 'kid') + ')</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
                '<span style="color:var(--text-primary);font-weight:600;">' + prefix + Number(contrib).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + '</span>' +
                '<span style="font-size:0.7rem;color:var(--text-secondary);min-width:32px;text-align:right;">' + pct + '%</span>' +
            '</div>' +
        '</div>';
    });
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0 2px;border-top:1px solid var(--border);margin-top:4px;font-weight:700;color:var(--text-primary);">' +
        '<span>Joint Total</span>' +
        '<span>' + prefix + Number(jointTotal).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + '</span>' +
    '</div>';
    listEl.innerHTML = html;
    el.style.display = '';
}

// =============================================
// FEATURE: Streak Tracker
// =============================================
function calculateStreak() {
    if (expenses.length === 0) return 0;
    var dates = {};
    expenses.forEach(function(e) { dates[e.date] = true; });
    var streak = 0;
    var d = new Date();
    // Check if today has expenses, if not start from yesterday
    var todayKey = d.toISOString().split('T')[0];
    if (!dates[todayKey]) {
        d.setDate(d.getDate() - 1);
    }
    while (true) {
        var key = d.toISOString().split('T')[0];
        if (dates[key]) {
            streak++;
            d.setDate(d.getDate() - 1);
        } else {
            break;
        }
    }
    return streak;
}

function renderStreak() {
    var streak = calculateStreak();
    var badge = document.getElementById('streakBadge');
    if (streak >= 2) {
        document.getElementById('streakCount').textContent = streak;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// =============================================
// FEATURE: Monthly Summary Card
// =============================================
function renderMonthlySummary() {
    var now = new Date();
    var sumMonthKey = now.getFullYear() + '-' + (now.getMonth() + 1);
    if (userSettings.summary_dismissed && userSettings.summary_dismissed[sumMonthKey]) return;

    var thisMonth = currentMonthExpenses();
    var thisTotal = thisMonth.reduce(function(s, e) { return s + e.amount; }, 0);

    // Get last month totals
    var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var prevKey = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
    var prevExp = expenses.filter(function(e) { return e.date.startsWith(prevKey); });
    var prevTotal = prevExp.reduce(function(s, e) { return s + e.amount; }, 0);

    if (prevTotal === 0 || thisTotal === 0) return;

    var diff = ((thisTotal - prevTotal) / prevTotal * 100).toFixed(0);
    var summaryEl = document.getElementById('monthlySummary');
    var textEl = document.getElementById('summaryText');

    // Category comparison
    var thisCats = {}, prevCats = {};
    thisMonth.forEach(function(e) { thisCats[e.category] = (thisCats[e.category] || 0) + e.amount; });
    prevExp.forEach(function(e) { prevCats[e.category] = (prevCats[e.category] || 0) + e.amount; });

    var biggestChange = null;
    var biggestPct = 0;
    Object.keys(thisCats).forEach(function(cat) {
        if (prevCats[cat]) {
            var catDiff = ((thisCats[cat] - prevCats[cat]) / prevCats[cat]) * 100;
            if (Math.abs(catDiff) > Math.abs(biggestPct)) {
                biggestPct = catDiff;
                biggestChange = cat;
            }
        }
    });

    var text = '';
    if (Number(diff) < 0) {
        text = 'You spent ' + Math.abs(diff) + '% less this month vs last month.';
    } else {
        text = 'You spent ' + diff + '% more this month vs last month.';
    }
    if (biggestChange && Math.abs(biggestPct) > 15) {
        text += ' ' + biggestChange + ' is ' + (biggestPct > 0 ? 'up' : 'down') + ' ' + Math.abs(Math.round(biggestPct)) + '%.';
    }

    textEl.textContent = text;
    summaryEl.classList.remove('hidden');

    document.getElementById('dismissSummary').onclick = function() {
        summaryEl.classList.add('hidden');
        var sd = userSettings.summary_dismissed || {};
        sd[sumMonthKey] = true;
        updateUserSetting('summary_dismissed', sd);
    };
}

// =============================================
// FEATURE: Floating Action Button (mobile)
// =============================================
function setupFAB() {
    document.getElementById('fabAdd').addEventListener('click', function() {
        document.getElementById('expenseModal').classList.remove('hidden');
    });
}

// =============================================
// FEATURE: Recurring Expenses Auto-Populate
// =============================================
async function autoPopulateRecurring() {
    var now = new Date();
    var thisKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var populatedKey = 'bw-recurring-' + thisKey;
    if (localStorage.getItem(populatedKey)) return;

    // Find recurring expenses from last month
    var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var prevKey = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
    var recurring = expenses.filter(function(e) {
        return e.date.startsWith(prevKey) && e.recurring === 'monthly';
    });

    // Also check weekly recurring from the past
    var weeklyRecurring = expenses.filter(function(e) {
        return e.recurring === 'weekly' && !e.date.startsWith(thisKey);
    });
    // Deduplicate weekly by description+amount
    var seenWeekly = {};
    var uniqueWeekly = [];
    weeklyRecurring.forEach(function(e) {
        var key = e.category + '|' + e.description + '|' + e.amount;
        if (!seenWeekly[key]) {
            seenWeekly[key] = true;
            uniqueWeekly.push(e);
        }
    });

    if (recurring.length === 0 && uniqueWeekly.length === 0) {
        localStorage.setItem(populatedKey, '1');
        return;
    }

    // Check if this month already has these expenses
    var thisMonthExp = expenses.filter(function(e) { return e.date.startsWith(thisKey); });
    var existingKeys = {};
    thisMonthExp.forEach(function(e) {
        existingKeys[e.category + '|' + e.description + '|' + e.amount] = true;
    });

    var toInsert = [];

    // Monthly recurring
    recurring.forEach(function(e) {
        var k = e.category + '|' + e.description + '|' + e.amount;
        if (!existingKeys[k]) {
            toInsert.push({
                user_id: currentUser.id,
                category: e.category,
                description: e.description,
                amount: e.amount,
                date: thisKey + '-01',
                recurring: e.recurring,
                account_mode: accountMode
            });
            existingKeys[k] = true;
        }
    });

    // Weekly recurring — add 4 entries for the month
    uniqueWeekly.forEach(function(e) {
        var k = e.category + '|' + e.description + '|' + e.amount;
        if (!existingKeys[k]) {
            for (var w = 0; w < 4; w++) {
                var day = 1 + (w * 7);
                toInsert.push({
                    user_id: currentUser.id,
                    category: e.category,
                    description: e.description,
                    amount: e.amount,
                    date: thisKey + '-' + String(day).padStart(2, '0'),
                    recurring: e.recurring,
                    account_mode: accountMode
                });
            }
            existingKeys[k] = true;
        }
    });

    if (toInsert.length > 0) {
        await supabase.from('expenses').insert(toInsert);
        localStorage.setItem(populatedKey, '1');
        // Reload to show new expenses
        await loadExpenses();
    } else {
        localStorage.setItem(populatedKey, '1');
    }
}

// =============================================
// FEATURE: Budget Limits per Category
// =============================================
function getBudgetLimits() {
    return userSettings.budget_limits || {};
}

function saveBudgetLimits(limits) {
    updateUserSetting('budget_limits', limits);
}

function setupBudgetLimits() {
    document.getElementById('budgetLimitsBtn').addEventListener('click', function() {
        renderBudgetLimitsModal();
        document.getElementById('budgetLimitsModal').classList.remove('hidden');
    });
    document.getElementById('closeBudgetLimitsModal').addEventListener('click', function() {
        document.getElementById('budgetLimitsModal').classList.add('hidden');
    });
}

function renderBudgetLimitsModal() {
    var container = document.getElementById('budgetLimitsList');
    container.innerHTML = '';
    var limits = getBudgetLimits();
    var allCats = defaultCategories.concat(customCategories.map(function(c) { return c.name; }));

    allCats.forEach(function(cat) {
        var row = document.createElement('div');
        row.className = 'budget-limit-row';
        row.innerHTML =
            '<div class="cat-color-dot" style="background:' + (categoryColors[cat] || '#6b7280') + '"></div>' +
            '<span class="limit-cat-name">' + cat + '</span>' +
            '<input type="number" class="limit-input" placeholder="No limit" min="0" step="0.01" value="' + (limits[cat] || '') + '" data-cat="' + cat + '">';
        container.appendChild(row);
    });

    // Save on input change
    container.addEventListener('input', function(e) {
        if (e.target.classList.contains('limit-input')) {
            var limits = getBudgetLimits();
            var val = parseFloat(e.target.value);
            if (val > 0) {
                limits[e.target.dataset.cat] = val;
            } else {
                delete limits[e.target.dataset.cat];
            }
            saveBudgetLimits(limits);
            renderBudgetWarnings();
        }
    });
}

function renderBudgetWarnings() {
    var limits = getBudgetLimits();
    var container = document.getElementById('budgetWarnings');
    container.innerHTML = '';
    var monthExp = currentMonthExpenses();
    var catTotals = {};
    monthExp.forEach(function(e) { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });

    var hasWarnings = false;
    Object.keys(limits).forEach(function(cat) {
        var spent = catTotals[cat] || 0;
        var limit = limits[cat];
        var pct = (spent / limit) * 100;
        if (pct >= 70) {
            hasWarnings = true;
            var warning = document.createElement('div');
            var level = pct >= 100 ? 'over' : pct >= 90 ? 'danger' : 'warn';
            warning.className = 'budget-warning-item budget-' + level;
            warning.innerHTML =
                '<div class="bw-info">' +
                    '<span class="bw-cat">' + cat + '</span>' +
                    '<span class="bw-detail">' + fmt(spent) + ' / ' + fmt(limit) + '</span>' +
                '</div>' +
                '<div class="bw-bar"><div class="bw-fill bw-fill-' + level + '" style="width:' + Math.min(100, pct) + '%"></div></div>';
            container.appendChild(warning);
        }
    });

    if (hasWarnings) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }
}

// =============================================
// FEATURE: Achievement Badges
// =============================================
var achievementDefs = [
    { id: 'first_expense', icon: '\uD83C\uDF1F', title: 'First Step', desc: 'Logged your first expense', check: function() { return expenses.length >= 1; } },
    { id: 'ten_expenses', icon: '\uD83D\uDCDD', title: 'Tracker', desc: 'Logged 10 expenses', check: function() { return expenses.length >= 10; } },
    { id: 'fifty_expenses', icon: '\uD83D\uDCDA', title: 'Bookkeeper', desc: 'Logged 50 expenses', check: function() { return expenses.length >= 50; } },
    { id: 'hundred_expenses', icon: '\uD83C\uDFC6', title: 'Centurion', desc: 'Logged 100 expenses', check: function() { return expenses.length >= 100; } },
    { id: 'goal_reached', icon: '\uD83C\uDF89', title: 'Goal Smasher', desc: 'Reached a savings goal', check: function() { return savingsGoals.some(function(g) { return g.saved_amount >= g.target_amount; }); } },
    { id: 'under_budget', icon: '\uD83D\uDCB0', title: 'Budget Boss', desc: 'Spent less than income this month', check: function() { var t = currentMonthExpenses().reduce(function(s,e){return s+e.amount;},0); return t > 0 && t < userSettings.income; } },
    { id: 'streak_7', icon: '\uD83D\uDD25', title: 'Week Warrior', desc: '7-day logging streak', check: function() { return calculateStreak() >= 7; } },
    { id: 'streak_30', icon: '\u2B50', title: 'Monthly Master', desc: '30-day logging streak', check: function() { return calculateStreak() >= 30; } },
    { id: 'five_categories', icon: '\uD83C\uDFA8', title: 'Diversified', desc: 'Used 5+ categories', check: function() { var c = {}; expenses.forEach(function(e) { c[e.category]=true; }); return Object.keys(c).length >= 5; } }
];

function renderAchievements() {
    var grid = document.getElementById('achievementsGrid');
    if (!grid) return;
    grid.innerHTML = '';

    achievementDefs.forEach(function(a) {
        var unlocked = a.check();
        var card = document.createElement('div');
        card.className = 'achievement-card' + (unlocked ? ' unlocked' : '');
        card.innerHTML =
            '<div class="achievement-icon">' + a.icon + '</div>' +
            '<div class="achievement-info">' +
                '<span class="achievement-title">' + a.title + '</span>' +
                '<span class="achievement-desc">' + a.desc + '</span>' +
            '</div>';
        grid.appendChild(card);
    });
}

// =============================================
// FEATURE: AI Spending Insights
// =============================================
function renderAIInsights() {
    var container = document.getElementById('aiInsights');
    if (!container) return;
    container.innerHTML = '';

    var monthExp = currentMonthExpenses();
    if (monthExp.length === 0) {
        container.innerHTML = '<p class="ai-placeholder">Add expenses to unlock AI-powered insights about your spending patterns.</p>';
        return;
    }

    var totalSpent = monthExp.reduce(function(s, e) { return s + e.amount; }, 0);
    var catTotals = {};
    monthExp.forEach(function(e) { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });

    var insights = [];

    // Pattern: Top spending category
    var topCat = Object.keys(catTotals).sort(function(a, b) { return catTotals[b] - catTotals[a]; })[0];
    var topPct = totalSpent > 0 ? Math.round((catTotals[topCat] / totalSpent) * 100) : 0;
    insights.push({
        type: topPct > 40 ? 'negative' : 'neutral',
        icon: '\uD83D\uDCCA',
        title: 'Top Category: ' + topCat,
        text: topCat + ' takes up ' + topPct + '% of your spending (' + fmt(catTotals[topCat]) + '). ' +
            (topPct > 40 ? 'This is quite concentrated — consider diversifying or reducing.' : 'This looks like a reasonable proportion.')
    });

    // Pattern: Spending velocity (daily average)
    var now = new Date();
    var dayOfMonth = now.getDate();
    var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var dailyAvg = totalSpent / dayOfMonth;
    var projectedTotal = dailyAvg * daysInMonth;
    var projected = Math.round(projectedTotal);
    if (userSettings.income > 0) {
        var projPct = Math.round((projectedTotal / userSettings.income) * 100);
        insights.push({
            type: projPct > 100 ? 'negative' : projPct > 80 ? 'neutral' : 'positive',
            icon: '\uD83D\uDE80',
            title: 'Spending Projection',
            text: 'At your current rate of ' + fmt(dailyAvg) + '/day, you\'re on track to spend ' + fmt(projected) + ' this month (' + projPct + '% of income). ' +
                (projPct > 100 ? 'You\'ll overshoot your budget — slow down spending now.' : projPct > 80 ? 'Getting close to your limit — be mindful.' : 'Looking good, you\'re well within budget.')
        });
    }

    // Pattern: Weekend vs weekday spending
    var weekdaySpend = 0, weekendSpend = 0, weekdayCount = 0, weekendCount = 0;
    monthExp.forEach(function(e) {
        var d = new Date(e.date).getDay();
        if (d === 0 || d === 6) { weekendSpend += e.amount; weekendCount++; }
        else { weekdaySpend += e.amount; weekdayCount++; }
    });
    if (weekendCount > 0 && weekdayCount > 0) {
        var wkdayAvg = weekdaySpend / weekdayCount;
        var wkendAvg = weekendSpend / weekendCount;
        if (wkendAvg > wkdayAvg * 1.5) {
            insights.push({
                type: 'negative',
                icon: '\uD83D\uDCC5',
                title: 'Weekend Spending Spike',
                text: 'You spend ' + fmt(wkendAvg) + ' per transaction on weekends vs ' + fmt(wkdayAvg) + ' on weekdays. Weekend impulse spending might be hurting your budget.'
            });
        } else {
            insights.push({
                type: 'positive',
                icon: '\uD83D\uDCC5',
                title: 'Consistent Spending Pattern',
                text: 'Your weekday and weekend spending are balanced — that\'s a sign of disciplined habits.'
            });
        }
    }

    // Pattern: Compare to last month
    var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var lmKey = lastMonth.getFullYear() + '-' + String(lastMonth.getMonth() + 1).padStart(2, '0');
    var lastMonthExp = expenses.filter(function(e) { return e.date.startsWith(lmKey); });
    if (lastMonthExp.length > 0) {
        var lastTotal = lastMonthExp.reduce(function(s, e) { return s + e.amount; }, 0);
        var changePct = lastTotal > 0 ? Math.round(((totalSpent - lastTotal) / lastTotal) * 100) : 0;
        insights.push({
            type: changePct > 20 ? 'negative' : changePct < -10 ? 'positive' : 'neutral',
            icon: changePct > 0 ? '\uD83D\uDCC8' : '\uD83D\uDCC9',
            title: 'Month-over-Month',
            text: changePct > 0
                ? 'Spending is up ' + changePct + '% vs last month (' + fmt(lastTotal) + ' \u2192 ' + fmt(totalSpent) + '). Check which categories grew.'
                : changePct < 0
                    ? 'Spending is down ' + Math.abs(changePct) + '% vs last month. Great cost-cutting!'
                    : 'Spending is roughly the same as last month.'
        });
    }

    // Pattern: Frequency analysis
    var catCounts = {};
    monthExp.forEach(function(e) { catCounts[e.category] = (catCounts[e.category] || 0) + 1; });
    var freqCat = Object.keys(catCounts).sort(function(a, b) { return catCounts[b] - catCounts[a]; })[0];
    if (catCounts[freqCat] > 5) {
        insights.push({
            type: 'neutral',
            icon: '\uD83D\uDD01',
            title: 'Frequent: ' + freqCat,
            text: 'You\'ve made ' + catCounts[freqCat] + ' ' + freqCat + ' transactions this month. Small purchases add up — they total ' + fmt(catTotals[freqCat]) + '.'
        });
    }

    // Pattern: Savings opportunity
    if (userSettings.income > 0 && totalSpent < userSettings.income) {
        var canSave = userSettings.income - totalSpent;
        var savePct = Math.round((canSave / userSettings.income) * 100);
        insights.push({
            type: 'positive',
            icon: '\uD83D\uDCB0',
            title: 'Savings Potential',
            text: 'You have ' + fmt(canSave) + ' (' + savePct + '%) left this month. ' +
                (savePct > 30 ? 'Excellent — consider moving some to savings goals.' : 'Keep watching your spending to maintain this buffer.')
        });
    }

    insights.forEach(function(ins) {
        var div = document.createElement('div');
        div.className = 'ai-insight ' + ins.type;
        div.innerHTML =
            '<div class="ai-insight-icon">' + ins.icon + '</div>' +
            '<div class="ai-insight-content">' +
                '<h4>' + ins.title + '</h4>' +
                '<p>' + ins.text + '</p>' +
            '</div>';
        container.appendChild(div);
    });
}

// =============================================
// FEATURE: Shared Budgets
// =============================================
var sharedGroups = [];

function setupSharedBudgets() {
    document.getElementById('createGroupBtn').addEventListener('click', function() {
        document.getElementById('createGroupModal').classList.remove('hidden');
    });
    document.getElementById('closeGroupModal').addEventListener('click', function() {
        document.getElementById('createGroupModal').classList.add('hidden');
    });
    document.getElementById('createGroupForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var name = document.getElementById('groupName').value.trim();
        var budget = parseFloat(document.getElementById('groupBudget').value);
        var membersRaw = document.getElementById('groupMembers').value.trim();
        var memberEmails = membersRaw ? membersRaw.split(',').map(function(m) { return m.trim(); }).filter(Boolean) : [];

        var result = await supabase.from('budget_groups').insert({
            name: name,
            budget: budget,
            owner_id: currentUser.id,
            members: [currentUser.email].concat(memberEmails)
        }).select().single();

        if (result.error) {
            alert('Error creating group: ' + result.error.message);
            return;
        }

        // Send invites (insert pending invitations)
        for (var i = 0; i < memberEmails.length; i++) {
            await supabase.from('group_invites').insert({
                group_id: result.data.id,
                email: memberEmails[i],
                invited_by: currentUser.email,
                status: 'pending'
            });
        }

        document.getElementById('createGroupModal').classList.add('hidden');
        document.getElementById('createGroupForm').reset();
        loadSharedGroups();
    });
}

async function loadSharedGroups() {
    // Load groups where user is owner or member
    var result = await supabase.from('budget_groups')
        .select('*')
        .or('owner_id.eq.' + currentUser.id + ',members.cs.{' + currentUser.email + '}');

    sharedGroups = result.data || [];

    // Load pending invites for this user
    var invites = await supabase.from('group_invites')
        .select('*, budget_groups(*)')
        .eq('email', currentUser.email)
        .eq('status', 'pending');

    renderSharedGroups(invites.data || []);
}

function renderSharedGroups(pendingInvites) {
    var container = document.getElementById('sharedGroups');
    if (!container) return;
    // Preserve noGroups before clearing innerHTML
    var noGroups = document.getElementById('noGroups');
    if (noGroups) noGroups.remove();
    container.innerHTML = '';

    // Show pending invites
    pendingInvites.forEach(function(inv) {
        var card = document.createElement('div');
        card.className = 'shared-group-card';
        card.style.borderColor = 'rgba(251,191,36,0.3)';
        card.innerHTML =
            '<h3>' + (inv.budget_groups ? inv.budget_groups.name : 'Budget Group') + '</h3>' +
            '<p class="group-meta">Invited by ' + inv.invited_by + '</p>' +
            '<div class="group-actions">' +
                '<button class="accept-invite" data-id="' + inv.id + '" data-group="' + inv.group_id + '">Accept</button>' +
                '<button class="decline-invite" data-id="' + inv.id + '">Decline</button>' +
            '</div>';
        container.appendChild(card);
    });

    if (sharedGroups.length === 0 && pendingInvites.length === 0) {
        if (noGroups) {
            container.appendChild(noGroups);
        } else {
            container.innerHTML = '<div class="empty-state"><p>No shared budgets yet. Create a group and invite members to start collaborating.</p></div>';
        }
        return;
    }

    sharedGroups.forEach(function(group) {
        var card = document.createElement('div');
        card.className = 'shared-group-card';
        var members = group.members || [];
        var memberAvatars = members.map(function(m) {
            var initial = m.charAt(0).toUpperCase();
            return '<div class="group-member-avatar">' + initial + '</div>';
        }).join('');

        var totalSpent = group.total_spent || 0;
        var pct = group.budget > 0 ? Math.min(100, Math.round((totalSpent / group.budget) * 100)) : 0;

        card.innerHTML =
            '<h3>' + group.name + '</h3>' +
            '<p class="group-meta">' + members.length + ' member' + (members.length !== 1 ? 's' : '') + ' \u2022 ' + (group.owner_id === currentUser.id ? 'You own this' : 'Member') + '</p>' +
            '<div class="group-budget-bar"><div class="group-budget-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="group-budget-text"><span>' + fmt(totalSpent) + ' spent</span><span>' + fmt(group.budget) + ' budget</span></div>' +
            '<div class="group-members">' + memberAvatars + '</div>' +
            '<div class="group-actions">' +
                '<button class="view-group" data-id="' + group.id + '">View Details</button>' +
                (group.owner_id === currentUser.id ? '<button class="delete-group" data-id="' + group.id + '">Delete</button>' : '') +
            '</div>';
        container.appendChild(card);
    });

    // Event delegation for shared budget actions
    container.addEventListener('click', async function(e) {
        if (e.target.classList.contains('accept-invite')) {
            await supabase.from('group_invites').update({ status: 'accepted' }).eq('id', e.target.dataset.id);
            loadSharedGroups();
        }
        if (e.target.classList.contains('decline-invite')) {
            await supabase.from('group_invites').update({ status: 'declined' }).eq('id', e.target.dataset.id);
            loadSharedGroups();
        }
        if (e.target.classList.contains('delete-group')) {
            if (confirm('Delete this group? All members will lose access.')) {
                await supabase.from('budget_groups').delete().eq('id', e.target.dataset.id);
                loadSharedGroups();
            }
        }
    });
}

// =============================================
// FEATURE: Bank Connect (Plaid)
// =============================================
var SUPABASE_FUNC_URL = 'https://trkdlwukjyupvvcyzebf.supabase.co/functions/v1';
var linkedAccounts = [];

function setupBankConnect() {
    var btn = document.getElementById('connectBankBtn');
    if (!btn) return;

    // Show region selector instead of going straight to Plaid
    btn.addEventListener('click', function() {
        if (!requirePro('Bank Sync')) return;
        document.getElementById('regionModal').classList.remove('hidden');
    });
    document.getElementById('closeRegionModal').addEventListener('click', function() {
        document.getElementById('regionModal').classList.add('hidden');
    });
    // Click outside modal to close
    document.getElementById('regionModal').addEventListener('click', function(e) {
        if (e.target === this) this.classList.add('hidden');
    });

    // Bank search functionality
    var bankSearchInput = document.getElementById('bankSearchInput');
    var bankSearchResult = document.getElementById('bankSearchResult');
    if (bankSearchInput) {
        // Build a map of bank names to region cards
        var bankMap = [];
        document.querySelectorAll('.region-card').forEach(function(card) {
            var banksText = card.querySelector('.region-banks');
            var regionName = card.querySelector('strong');
            if (banksText && regionName) {
                var banks = banksText.textContent.split(',').map(function(b) { return b.trim(); });
                banks.forEach(function(bank) {
                    bankMap.push({ name: bank.toLowerCase(), card: card, region: regionName.textContent });
                });
            }
        });

        bankSearchInput.addEventListener('input', function() {
            var q = this.value.trim().toLowerCase();
            var cards = document.querySelectorAll('.region-card');
            if (!q) {
                cards.forEach(function(c) { c.classList.remove('search-match', 'search-dim'); });
                bankSearchResult.classList.add('hidden');
                return;
            }
            var matchedCards = new Set();
            var matchedBanks = [];
            bankMap.forEach(function(entry) {
                if (entry.name.indexOf(q) !== -1) {
                    matchedCards.add(entry.card);
                    matchedBanks.push(entry.name.replace(/\b\w/g, function(c) { return c.toUpperCase(); }) + ' — ' + entry.region);
                }
            });
            cards.forEach(function(c) {
                if (matchedCards.has(c)) {
                    c.classList.add('search-match');
                    c.classList.remove('search-dim');
                } else {
                    c.classList.remove('search-match');
                    c.classList.add('search-dim');
                }
            });
            if (matchedBanks.length > 0) {
                bankSearchResult.textContent = 'Found: ' + matchedBanks.slice(0, 3).join(', ') + (matchedBanks.length > 3 ? ' +' + (matchedBanks.length - 3) + ' more' : '');
                bankSearchResult.classList.remove('hidden');
            } else {
                bankSearchResult.textContent = 'No banks found matching "' + this.value.trim() + '"';
                bankSearchResult.classList.remove('hidden');
                cards.forEach(function(c) { c.classList.remove('search-dim'); });
            }
        });
    }

    // Region card clicks
    var readyProviders = ['plaid', 'stitch', 'saltedge'];
    document.getElementById('regionGrid').addEventListener('click', function(e) {
        var card = e.target.closest('.region-card');
        if (!card) return;
        var provider = card.dataset.provider;

        if (readyProviders.indexOf(provider) === -1) {
            alert('This region is coming soon! We are working on integrating ' + card.querySelector('strong').textContent + '. Stay tuned.');
            return;
        }

        document.getElementById('regionModal').classList.add('hidden');

        var providerMap = {
            plaid: openPlaidLink,
            stitch: openStitchLink,
            saltedge: openSaltEdgeConnect
        };
        if (providerMap[provider]) {
            providerMap[provider]();
        }
    });

    // Event delegation for bank card actions
    document.getElementById('bankCardsGrid').addEventListener('click', async function(e) {
        var syncBtn = e.target.closest('.btn-sync');
        var updateBtn = e.target.closest('.btn-update-balance');
        var removeBtn = e.target.closest('.btn-remove');
        if (syncBtn) {
            syncBtn.textContent = 'Syncing...';
            syncBtn.disabled = true;
            await syncAccount(syncBtn.dataset.id);
            syncBtn.textContent = 'Sync';
            syncBtn.disabled = false;
        }
        if (updateBtn) {
            var newBalance = prompt('Enter updated balance:');
            if (newBalance !== null && !isNaN(parseFloat(newBalance))) {
                updateBtn.textContent = 'Saving...';
                updateBtn.disabled = true;
                await supabase.from('linked_accounts').update({
                    balance_current: parseFloat(newBalance),
                    balance_available: parseFloat(newBalance),
                    last_synced: new Date().toISOString()
                }).eq('id', updateBtn.dataset.id);
                await loadLinkedAccounts();
            }
        }
        if (removeBtn) {
            if (confirm('Remove this account? Transaction history will be kept.')) {
                await supabase.from('linked_accounts').delete().eq('id', removeBtn.dataset.id);
                loadLinkedAccounts();
            }
        }
    });
}

async function openPlaidLink() {
    var btn = document.getElementById('connectBankBtn');
    if (typeof Plaid === 'undefined') {
        alert('Bank connection is loading. Please wait a moment and try again.');
        return;
    }
    btn.disabled = true;
    var origHTML = btn.innerHTML;
    btn.textContent = 'Connecting...';
    try {
        var session = (await supabase.auth.getSession()).data.session;
        var res = await fetch(SUPABASE_FUNC_URL + '/plaid-link-token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (session ? session.access_token : '')
            },
            body: JSON.stringify({ user_id: currentUser.id })
        });
        var data = await res.json();

        if (!data.link_token) {
            alert('Error connecting to bank: ' + (data.error_message || data.error || 'Please try again.'));
            btn.disabled = false;
            btn.innerHTML = origHTML;
            return;
        }

        var handler = Plaid.create({
            token: data.link_token,
            onSuccess: async function(publicToken, metadata) {
                await handlePlaidSuccess(publicToken, metadata);
            },
            onExit: function(err) {
                btn.disabled = false;
                btn.innerHTML = origHTML;
                if (err) console.error('Plaid exit error:', err);
            }
        });
        handler.open();
    } catch (err) {
        alert('Connection error: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = origHTML;
    }
}

async function handlePlaidSuccess(publicToken, metadata) {
    var btn = document.getElementById('connectBankBtn');
    btn.textContent = 'Importing...';

    try {
        var exSession = (await supabase.auth.getSession()).data.session;
        var res = await fetch(SUPABASE_FUNC_URL + '/plaid-exchange-token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (exSession ? exSession.access_token : '')
            },
            body: JSON.stringify({ public_token: publicToken })
        });
        var data = await res.json();

        if (data.error) {
            alert('Error: ' + data.error);
            btn.disabled = false;
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Account';
            return;
        }

        var institutionName = (metadata && metadata.institution) ? metadata.institution.name : 'Bank';

        // Save each account to Supabase
        if (data.accounts && data.accounts.length > 0) {
            for (var i = 0; i < data.accounts.length; i++) {
                var acc = data.accounts[i];
                await supabase.from('linked_accounts').insert({
                    user_id: currentUser.id,
                    plaid_access_token: data.access_token,
                    account_id: acc.account_id,
                    account_name: acc.name,
                    account_type: acc.type,
                    account_subtype: acc.subtype || acc.type,
                    institution_name: institutionName,
                    mask: acc.mask || '****',
                    balance_current: acc.balances.current,
                    balance_available: acc.balances.available,
                    currency_code: acc.balances.iso_currency_code || 'USD',
                    last_synced: new Date().toISOString(),
                    account_mode: accountMode
                });
            }
        }

        // Import transactions — route incoming money through popup, auto-import expenses
        if (data.transactions && data.transactions.length > 0) {
            var catMap = {
                'Food and Drink': 'Food', 'Travel': 'Transport', 'Transfer': 'Other',
                'Payment': 'Other', 'Shops': 'Shopping', 'Recreation': 'Entertainment',
                'Service': 'Utilities', 'Healthcare': 'Health', 'Bank Fees': 'Other'
            };

            var imported = 0;
            var incomingTxQueue = [];
            for (var j = 0; j < Math.min(data.transactions.length, 50); j++) {
                var tx = data.transactions[j];
                // Plaid: positive = money out (expense), negative = money in (income/deposit)
                if (tx.amount > 0) {
                    // Expense — import directly to current mode
                    var category = 'Other';
                    if (tx.category && tx.category.length > 0) {
                        category = catMap[tx.category[0]] || 'Other';
                    }
                    await supabase.from('expenses').insert({
                        user_id: currentUser.id,
                        category: category,
                        description: tx.name,
                        amount: tx.amount,
                        date: tx.date,
                        recurring: 'no',
                        account_mode: accountMode
                    });
                    imported++;
                } else {
                    // Income/deposit — queue for routing popup
                    incomingTxQueue.push({
                        amount: Math.abs(tx.amount),
                        name: tx.name,
                        description: tx.name,
                        date: tx.date,
                        category: tx.category || []
                    });
                }
            }
            await loadExpenses();
            if (imported > 0) showUndoToast('Imported ' + imported + ' expense' + (imported > 1 ? 's' : ''));

            // Phase 3: Show routing popup for incoming money
            if (incomingTxQueue.length > 0) {
                processRoutingQueue(incomingTxQueue);
            }
        }

        await loadLinkedAccounts();
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Account';
    } catch (err) {
        alert('Error importing: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Account';
    }
}

async function loadLinkedAccounts() {
    try {
        var result = await supabase.from('linked_accounts')
            .select('*')
            .eq('user_id', currentUser.id)
            .eq('account_mode', accountMode)
            .order('created_at', { ascending: false });
        linkedAccounts = result.data || [];
    } catch(e) {
        // Fallback: if account_mode column doesn't exist yet, load all
        var result2 = await supabase.from('linked_accounts')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false });
        linkedAccounts = result2.data || [];
    }
    renderBankCards();
}

async function syncAccount(accountId) {
    // Re-fetch balance for a specific account via Plaid
    var account = linkedAccounts.find(function(a) { return a.id === accountId; });
    if (!account) return;

    try {
        var syncSession = (await supabase.auth.getSession()).data.session;
        var res = await fetch(SUPABASE_FUNC_URL + '/plaid-exchange-token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (syncSession ? syncSession.access_token : '')
            },
            body: JSON.stringify({ access_token: account.plaid_access_token })
        });
        var data = await res.json();

        if (data.accounts) {
            var match = data.accounts.find(function(a) { return a.account_id === account.account_id; });
            if (match) {
                await supabase.from('linked_accounts').update({
                    balance_current: match.balances.current,
                    balance_available: match.balances.available,
                    last_synced: new Date().toISOString()
                }).eq('id', accountId);
            }
        }
        await loadLinkedAccounts();
    } catch (err) {
        console.error('Sync error:', err);
    }
}

// =============================================
// PROVIDER: Stitch (South Africa)
// =============================================
// South Africa — manual bank add with SA bank picker
async function openStitchLink() {
    document.getElementById('regionModal').classList.add('hidden');
    document.getElementById('saBankModal').classList.remove('hidden');
}

// =============================================
// Salt Edge — inactive until API keys are configured
// To activate: add your Salt Edge App ID + Secret to Supabase Edge Functions
// Then set SALT_EDGE_ACTIVE = true below
// =============================================
var SALT_EDGE_ACTIVE = false;

async function openSaltEdgeConnect() {
    if (!SALT_EDGE_ACTIVE) {
        alert('Salt Edge bank sync is coming soon! For now, you can add your bank manually.');
        document.getElementById('saBankModal').classList.remove('hidden');
        return;
    }

    var btn = document.getElementById('connectBankBtn');
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {
        // Request a Salt Edge Connect session from your backend
        var res = await fetch(SUPABASE_FUNC_URL + '/saltedge-connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: currentUser.id })
        });
        var data = await res.json();

        if (!data.connect_url) {
            alert('Error connecting: ' + (data.error || 'Please try again.'));
            btn.disabled = false;
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Account';
            return;
        }

        // Open Salt Edge Connect in a popup
        var popup = window.open(data.connect_url, 'saltedge', 'width=500,height=700');

        // Listen for callback when user finishes
        var checkClosed = setInterval(async function() {
            if (popup && popup.closed) {
                clearInterval(checkClosed);
                btn.textContent = 'Importing...';

                // Fetch the connection data from backend
                var connRes = await fetch(SUPABASE_FUNC_URL + '/saltedge-accounts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: currentUser.id })
                });
                var connData = await connRes.json();

                if (connData.accounts && connData.accounts.length > 0) {
                    for (var i = 0; i < connData.accounts.length; i++) {
                        var acc = connData.accounts[i];
                        await supabase.from('linked_accounts').insert({
                            user_id: currentUser.id,
                            plaid_access_token: 'saltedge:' + connData.connection_id,
                            account_id: acc.id,
                            account_name: acc.name,
                            account_type: acc.nature || 'account',
                            account_subtype: acc.nature || 'checking',
                            institution_name: connData.provider_name || 'Bank',
                            mask: '••••',
                            balance_current: acc.balance,
                            balance_available: acc.balance,
                            currency_code: acc.currency_code || 'ZAR',
                            last_synced: new Date().toISOString(),
                            account_mode: accountMode
                        });
                    }
                }

                // Import transactions
                if (connData.transactions && connData.transactions.length > 0) {
                    var imported = 0;
                    for (var j = 0; j < Math.min(connData.transactions.length, 50); j++) {
                        var tx = connData.transactions[j];
                        if (tx.amount <= 0) continue;
                        await supabase.from('expenses').insert({
                            user_id: currentUser.id,
                            category: tx.category || 'Other',
                            description: tx.description,
                            amount: Math.abs(tx.amount),
                            date: tx.made_on,
                            recurring: 'no',
                            account_mode: accountMode
                        });
                        imported++;
                    }
                    await loadExpenses();
                    if (imported > 0) alert('Imported ' + imported + ' transactions!');
                }

                await loadLinkedAccounts();
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Account';
            }
        }, 500);
    } catch (err) {
        alert('Connection error: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Account';
    }
}

async function addManualSABank(bankName, accountName, accountType, balance) {
    var subtypeMap = { 'cheque': 'checking', 'savings': 'savings', 'credit': 'credit card' };
    var cardType = subtypeMap[accountType] || 'checking';
    await supabase.from('linked_accounts').insert({
        user_id: currentUser.id,
        plaid_access_token: 'manual',
        account_id: 'sa-manual-' + Date.now(),
        account_name: accountName || bankName + ' Account',
        account_type: accountType === 'credit' ? 'credit' : 'depository',
        account_subtype: cardType,
        institution_name: bankName,
        mask: '••••',
        balance_current: balance || 0,
        balance_available: balance || 0,
        currency_code: 'ZAR',
        account_mode: accountMode
    });
    await loadLinkedAccounts();
}

function setupSABankModal() {
    var modal = document.getElementById('saBankModal');
    if (!modal) return;

    document.getElementById('closeSABankModal').addEventListener('click', function() {
        modal.classList.add('hidden');
    });
    modal.addEventListener('click', function(e) {
        if (e.target === this) this.classList.add('hidden');
    });

    // SA bank search
    var saBankSearch = document.getElementById('saBankSearchInput');
    if (saBankSearch) {
        saBankSearch.addEventListener('input', function() {
            var q = this.value.trim().toLowerCase();
            document.querySelectorAll('.sa-bank-btn').forEach(function(btn) {
                var name = (btn.dataset.bank + ' ' + (btn.querySelector('.sa-bank-full') ? btn.querySelector('.sa-bank-full').textContent : '')).toLowerCase();
                btn.style.display = !q || name.indexOf(q) !== -1 ? '' : 'none';
            });
        });
    }

    // Bank selection
    document.getElementById('saBankList').addEventListener('click', function(e) {
        var bankBtn = e.target.closest('.sa-bank-btn');
        if (!bankBtn) return;
        document.querySelectorAll('.sa-bank-btn').forEach(function(b) { b.classList.remove('selected'); });
        bankBtn.classList.add('selected');
        document.getElementById('selectedSABank').value = bankBtn.dataset.bank;
        document.getElementById('saBankForm').style.display = '';
    });

    // Form submit
    document.getElementById('saBankForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var bankName = document.getElementById('selectedSABank').value;
        var accountName = document.getElementById('saAccountName').value.trim();
        var accountType = document.getElementById('saAccountType').value;
        var balance = parseFloat(document.getElementById('saBalance').value) || 0;

        var btn = this.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding...';

        await addManualSABank(bankName, accountName, accountType, balance);

        btn.disabled = false;
        btn.textContent = 'Add Account';
        modal.classList.add('hidden');
        this.reset();
        document.getElementById('saBankForm').style.display = 'none';
        document.querySelectorAll('.sa-bank-btn').forEach(function(b) { b.classList.remove('selected'); });
    });
}

// =============================================
// PROVIDER: Mono (Nigeria, Ghana, Kenya)
// =============================================
async function openMonoLink() {
    var btn = document.getElementById('connectBankBtn');
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    try {
        var res = await fetch(SUPABASE_FUNC_URL + '/mono-link-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: currentUser.id })
        });
        var data = await res.json();
        if (data.key) {
            // Mono uses MonoConnect widget
            var monoInstance = new MonoConnect({
                key: data.key,
                onSuccess: function(response) { handleMonoSuccess(response); }
            });
            monoInstance.open();
        } else {
            alert('Mono is not configured yet.\n\nTo enable Nigerian/Ghanaian/Kenyan banks:\n1. Sign up at mono.co\n2. Get your public key & secret\n3. Add MONO_SECRET_KEY to Supabase secrets');
        }
    } catch (err) {
        alert('Mono is not configured yet.\n\nTo enable Nigerian/Ghanaian/Kenyan banks:\n1. Sign up at mono.co\n2. Get your public key & secret\n3. Add MONO_SECRET_KEY to Supabase secrets');
    }
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Account';
}

async function handleMonoSuccess(response) {
    // Exchange Mono code for account data
    try {
        var res = await fetch(SUPABASE_FUNC_URL + '/mono-exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: response.code })
        });
        var data = await res.json();
        if (data.accounts) {
            for (var i = 0; i < data.accounts.length; i++) {
                var acc = data.accounts[i];
                await supabase.from('linked_accounts').insert({
                    user_id: currentUser.id,
                    plaid_access_token: data.id || 'mono',
                    account_id: acc.id || ('mono-' + i),
                    account_name: acc.name || 'Account',
                    account_type: acc.type || 'depository',
                    account_subtype: acc.subtype || 'checking',
                    institution_name: acc.institution || 'Bank',
                    mask: acc.account_number ? acc.account_number.slice(-4) : '****',
                    balance_current: acc.balance,
                    balance_available: acc.balance,
                    currency_code: acc.currency || 'NGN',
                    account_mode: accountMode
                });
            }
            await loadLinkedAccounts();
        }
    } catch (err) {
        console.error('Mono import error:', err);
    }
}

// =============================================
// PROVIDER: Belvo (Brazil, Mexico, Colombia)
// =============================================
async function openBelvoLink() {
    alert('Belvo is not configured yet.\n\nTo enable Latin American banks:\n1. Sign up at belvo.com\n2. Get your secret_id & secret_password\n3. Add BELVO_SECRET_ID and BELVO_SECRET_PASSWORD to Supabase secrets');
}

// =============================================
// PROVIDER: Basiq (Australia, NZ)
// =============================================
async function openBasiqLink() {
    alert('Basiq is not configured yet.\n\nTo enable AU/NZ banks:\n1. Sign up at basiq.io\n2. Get your API key\n3. Add BASIQ_API_KEY to Supabase secrets');
}

// =============================================
// PROVIDER: Setu (India)
// =============================================
async function openSetuLink() {
    alert('Setu is not configured yet.\n\nTo enable Indian banks & UPI:\n1. Sign up at setu.co\n2. Get your client_id & secret\n3. Add SETU_CLIENT_ID and SETU_SECRET to Supabase secrets');
}

// =============================================
// PROVIDER: Lean Technologies (Middle East)
// =============================================
async function openLeanLink() {
    alert('Lean is not configured yet.\n\nTo enable Middle Eastern banks:\n1. Sign up at leantech.me\n2. Get your app_token\n3. Add LEAN_APP_TOKEN to Supabase secrets');
}

// =============================================
// PROVIDER: Brankas (Southeast Asia)
// =============================================
async function openBrankasLink() {
    alert('Brankas is not configured yet.\n\nTo enable Southeast Asian banks:\n1. Sign up at brankas.com\n2. Get your API key\n3. Add BRANKAS_API_KEY to Supabase secrets');
}

// =============================================
// PROVIDER: Salt Edge (Europe Extended)
// =============================================
async function openSaltEdgeLink() {
    alert('Salt Edge is not configured yet.\n\nTo enable 5000+ European banks:\n1. Sign up at saltedge.com\n2. Get your app_id & secret\n3. Add SALTEDGE_APP_ID and SALTEDGE_SECRET to Supabase secrets');
}

// =============================================
// PROVIDER: Moneytree (East Asia)
// =============================================
async function openMoneytreeLink() {
    alert('Moneytree is not configured yet.\n\nTo enable Japanese, Korean & East Asian banks:\n1. Sign up at moneytree.jp\n2. Get your client_id & secret\n3. Add MONEYTREE_CLIENT_ID and MONEYTREE_SECRET to Supabase secrets');
}

function renderBankCards() {
    var grid = document.getElementById('bankCardsGrid');
    var banner = document.getElementById('bankBalanceBanner');
    var emptyState = document.getElementById('bankEmptyState');

    grid.innerHTML = '';

    if (linkedAccounts.length === 0) {
        banner.style.display = 'none';
        emptyState.style.display = '';
        return;
    }

    emptyState.style.display = 'none';
    banner.style.display = '';

    // Calculate total balance
    var totalBalance = 0;
    linkedAccounts.forEach(function(acc) {
        totalBalance += acc.balance_current || 0;
    });
    document.getElementById('totalBankBalance').textContent = fmt(totalBalance);
    document.getElementById('bankAccountCount').textContent = linkedAccounts.length + ' account' + (linkedAccounts.length !== 1 ? 's' : '') + ' linked';

    // Render each card
    linkedAccounts.forEach(function(acc) {
        var cardType = 'checking';
        if (acc.account_subtype === 'savings') cardType = 'savings-card';
        else if (acc.account_subtype === 'credit card' || acc.account_type === 'credit') cardType = 'credit';

        var mask = acc.mask || '****';
        var dots = '\u2022\u2022\u2022\u2022  \u2022\u2022\u2022\u2022  \u2022\u2022\u2022\u2022  ' + mask;
        var synced = acc.last_synced ? new Date(acc.last_synced).toLocaleDateString() : 'Never';

        var isManual = acc.plaid_access_token === 'manual';
        var syncBtnLabel = isManual ? 'Update' : 'Sync';
        var syncBtnClass = isManual ? 'btn-update-balance' : 'btn-sync';

        var card = document.createElement('div');
        card.className = 'bank-card ' + cardType;
        card.innerHTML =
            '<div class="bank-card-top">' +
                '<span class="bank-card-institution">' + (acc.institution_name || 'Bank') + '</span>' +
                '<span class="bank-card-type">' + acc.account_subtype + '</span>' +
            '</div>' +
            '<div class="bank-card-number">' + dots + '</div>' +
            '<div class="bank-card-bottom">' +
                '<div>' +
                    '<div class="bank-card-balance-label">' + (acc.account_type === 'credit' ? 'Balance Owed' : 'Available') + '</div>' +
                    '<div class="bank-card-balance">' + fmt(acc.balance_current || 0) + '</div>' +
                '</div>' +
                '<div class="bank-card-actions">' +
                    '<button class="' + syncBtnClass + '" data-id="' + acc.id + '">' + syncBtnLabel + '</button>' +
                    '<button class="btn-remove" data-id="' + acc.id + '">Remove</button>' +
                '</div>' +
            '</div>';
        grid.appendChild(card);
    });
}

// ============================================================
// BUSINESS FEATURES: Invoices, Clients, P&L, Tax
// ============================================================

var businessCategories = [
    { value: 'COGS', label: 'Cost of Goods Sold' },
    { value: 'Payroll', label: 'Payroll & Wages' },
    { value: 'Rent & Lease', label: 'Rent & Lease' },
    { value: 'Marketing', label: 'Marketing & Advertising' },
    { value: 'Software & SaaS', label: 'Software & SaaS' },
    { value: 'Professional Fees', label: 'Legal / Accounting Fees' },
    { value: 'Office Expenses', label: 'Office Expenses' },
    { value: 'Travel & Mileage', label: 'Travel & Mileage' },
    { value: 'Client Meals', label: 'Client Meals & Entertainment' },
    { value: 'Equipment', label: 'Equipment & Assets' },
    { value: 'Insurance', label: 'Business Insurance' },
    { value: 'Taxes & Licenses', label: 'Taxes & Licenses' },
    { value: 'Contractors', label: 'Contractors & Freelancers' },
    { value: 'Shipping & Logistics', label: 'Shipping & Logistics' },
    { value: 'Bank & Processing Fees', label: 'Bank & Processing Fees' },
    { value: 'Tithe', label: 'Tithe (10%)' },
    { value: 'Miscellaneous', label: 'Miscellaneous' }
];

var personalCategories = [
    { value: 'Housing', label: 'Housing / Rent' },
    { value: 'Food', label: 'Food & Groceries' },
    { value: 'Transport', label: 'Transport' },
    { value: 'Utilities', label: 'Utilities (Electric, Water, WiFi)' },
    { value: 'Entertainment', label: 'Entertainment' },
    { value: 'Shopping', label: 'Shopping' },
    { value: 'Health', label: 'Health & Medical' },
    { value: 'Education', label: 'Education' },
    { value: 'Subscriptions', label: 'Subscriptions' },
    { value: 'Personal', label: 'Personal Care' },
    { value: 'Savings', label: 'Savings / Investment' },
    { value: 'Tithe', label: 'Tithe (10%)' },
    { value: 'Other', label: 'Other' }
];

var familyCategories = [
    { value: 'Groceries', label: 'Groceries' },
    { value: 'Household Bills', label: 'Household Bills' },
    { value: 'School Fees', label: 'School Fees' },
    { value: 'Medical', label: 'Medical & Health' },
    { value: 'Clothing', label: 'Clothing' },
    { value: 'Entertainment', label: 'Family Entertainment' },
    { value: 'Outings', label: 'Outings & Activities' },
    { value: 'Transport', label: 'Transport' },
    { value: 'Pocket Money', label: 'Pocket Money' },
    { value: 'Gifts', label: 'Gifts' },
    { value: 'Pets', label: 'Pets' },
    { value: 'Family Savings', label: 'Family Savings' },
    { value: 'Other', label: 'Other' }
];

function swapExpenseCategories(mode) {
    var cats = mode === 'business' ? businessCategories : (mode === 'family' ? familyCategories : personalCategories);
    var selects = [document.getElementById('expCategory'), document.getElementById('categoryFilter'), document.getElementById('quickCategory')];
    selects.forEach(function(sel) {
        if (!sel) return;
        var isFilter = sel.id === 'categoryFilter';
        var isQuick = sel.id === 'quickCategory';
        sel.innerHTML = '';
        if (isFilter) {
            var all = document.createElement('option');
            all.value = '';
            all.textContent = 'All Categories';
            sel.appendChild(all);
        } else if (!isQuick) {
            var def = document.createElement('option');
            def.value = '';
            def.textContent = 'Select...';
            sel.appendChild(def);
        }
        cats.forEach(function(c) {
            var opt = document.createElement('option');
            opt.value = c.value;
            var icon = categoryIcons[c.value] || '';
            opt.textContent = icon ? icon + ' ' + c.label : c.label;
            sel.appendChild(opt);
        });
    });
}

var businessCategoryColors = {
    'Office Supplies': '#3b82f6',
    'Marketing': '#ec4899',
    'Software': '#8b5cf6',
    'Rent': '#10b981',
    'Travel': '#f97316',
    'Payroll': '#06b6d4',
    'Professional Services': '#6366f1',
    'Insurance': '#14b8a6',
    'Utilities': '#f59e0b',
    'Equipment': '#e879f9',
    'Meals': '#22d3ee',
    'Training': '#a855f7',
    'Shipping': '#fb923c',
    'Subscriptions': '#2dd4bf',
    'Other': '#6b7280'
};

// --- INVOICES ---
var invoices = [];

function setupInvoices() {
    document.getElementById('addInvoiceBtn').addEventListener('click', function() {
        populateInvoiceClientSelect();
        document.getElementById('invDate').value = new Date().toISOString().split('T')[0];
        var due = new Date();
        due.setDate(due.getDate() + 30);
        document.getElementById('invDueDate').value = due.toISOString().split('T')[0];
        document.getElementById('invoiceModal').classList.remove('hidden');
    });
    document.getElementById('closeInvoiceModal').addEventListener('click', function() {
        document.getElementById('invoiceModal').classList.add('hidden');
    });
    document.getElementById('invoiceForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var inv = {
            user_id: currentUser.id,
            client_id: document.getElementById('invClient').value,
            description: document.getElementById('invDescription').value,
            amount: parseFloat(document.getElementById('invAmount').value),
            invoice_date: document.getElementById('invDate').value,
            due_date: document.getElementById('invDueDate').value,
            status: 'pending',
            account_mode: 'business'
        };
        await supabase.from('invoices').insert(inv);
        document.getElementById('invoiceForm').reset();
        document.getElementById('invoiceModal').classList.add('hidden');
        loadInvoices();
    });
}

function populateInvoiceClientSelect() {
    var sel = document.getElementById('invClient');
    sel.innerHTML = '<option value="">Select client...</option>';
    clients.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        sel.appendChild(opt);
    });
}

async function loadInvoices() {
    if (accountMode !== 'business') return;
    try {
        var result = await supabase
            .from('invoices')
            .select('*')
            .eq('user_id', currentUser.id)
            .eq('account_mode', 'business')
            .order('invoice_date', { ascending: false });
        invoices = result.data || [];
    } catch(e) { invoices = []; }
    renderInvoices();
}

function renderInvoices() {
    var body = document.getElementById('invoiceBody');
    var empty = document.getElementById('emptyInvoices');
    body.innerHTML = '';

    if (invoices.length === 0) {
        empty.style.display = '';
        document.getElementById('invTotal').textContent = fmt(0);
        document.getElementById('invPending').textContent = fmt(0);
        document.getElementById('invPaid').textContent = fmt(0);
        document.getElementById('invOverdue').textContent = fmt(0);
        return;
    }
    empty.style.display = 'none';

    var totalAmt = 0, pendingAmt = 0, paidAmt = 0, overdueAmt = 0;
    var today = new Date().toISOString().split('T')[0];

    invoices.forEach(function(inv, idx) {
        totalAmt += inv.amount;
        var status = inv.status;
        if (status === 'pending' && inv.due_date < today) status = 'overdue';
        if (status === 'paid') paidAmt += inv.amount;
        else if (status === 'overdue') overdueAmt += inv.amount;
        else pendingAmt += inv.amount;

        var client = clients.find(function(c) { return c.id === inv.client_id; });
        var clientName = client ? client.name : 'Unknown';
        var invNum = 'INV-' + String(idx + 1).padStart(3, '0');

        var statusClass = status === 'paid' ? 'status-paid' : status === 'overdue' ? 'status-overdue' : 'status-pending';
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td>' + invNum + '</td>' +
            '<td>' + escapeHtml(clientName) + '</td>' +
            '<td>' + fmt(inv.amount) + '</td>' +
            '<td>' + inv.invoice_date + '</td>' +
            '<td>' + inv.due_date + '</td>' +
            '<td><span class="inv-status ' + statusClass + '">' + status.charAt(0).toUpperCase() + status.slice(1) + '</span></td>' +
            '<td class="actions-cell">' +
                (status !== 'paid' ? '<button class="btn-mark-paid" data-id="' + inv.id + '">Mark Paid</button>' : '') +
                '<button class="btn-delete" data-id="' + inv.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>' +
            '</td>';
        body.appendChild(tr);
    });

    document.getElementById('invTotal').textContent = fmt(totalAmt);
    document.getElementById('invPending').textContent = fmt(pendingAmt);
    document.getElementById('invPaid').textContent = fmt(paidAmt);
    document.getElementById('invOverdue').textContent = fmt(overdueAmt);

    body.querySelectorAll('.btn-mark-paid').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            await supabase.from('invoices').update({ status: 'paid' }).eq('id', btn.dataset.id);
            loadInvoices();
        });
    });
    body.querySelectorAll('.btn-delete').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            await supabase.from('invoices').delete().eq('id', btn.dataset.id);
            loadInvoices();
        });
    });
}

// --- CLIENTS ---
var clients = [];

function setupClients() {
    document.getElementById('addClientBtn').addEventListener('click', function() {
        document.getElementById('clientModal').classList.remove('hidden');
    });
    document.getElementById('closeClientModal').addEventListener('click', function() {
        document.getElementById('clientModal').classList.add('hidden');
    });
    document.getElementById('clientForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var client = {
            user_id: currentUser.id,
            name: document.getElementById('clientName').value,
            email: document.getElementById('clientEmail').value || null,
            phone: document.getElementById('clientPhone').value || null,
            company: document.getElementById('clientCompany').value || null,
            account_mode: 'business'
        };
        await supabase.from('clients').insert(client);
        document.getElementById('clientForm').reset();
        document.getElementById('clientModal').classList.add('hidden');
        loadClients();
    });
}

async function loadClients() {
    if (accountMode !== 'business') return;
    try {
        var result = await supabase
            .from('clients')
            .select('*')
            .eq('user_id', currentUser.id)
            .eq('account_mode', 'business')
            .order('created_at', { ascending: false });
        clients = result.data || [];
    } catch(e) { clients = []; }
    renderClients();
}

function renderClients() {
    var grid = document.getElementById('clientsGrid');
    grid.innerHTML = '';

    document.getElementById('clientCount').textContent = clients.length;

    if (clients.length === 0) {
        grid.innerHTML = '<p class="empty-state">No clients yet. Add your first client to start tracking.</p>';
        document.getElementById('clientRevenue').textContent = fmt(0);
        return;
    }

    var clientRevMap = {};
    invoices.forEach(function(inv) {
        if (inv.status === 'paid') {
            clientRevMap[inv.client_id] = (clientRevMap[inv.client_id] || 0) + inv.amount;
        }
    });
    var totalRev = Object.values(clientRevMap).reduce(function(s, v) { return s + v; }, 0);
    document.getElementById('clientRevenue').textContent = fmt(totalRev);

    clients.forEach(function(c) {
        var rev = clientRevMap[c.id] || 0;
        var invCount = invoices.filter(function(i) { return i.client_id === c.id; }).length;
        var initials = c.name.split(' ').map(function(w) { return w.charAt(0); }).join('').toUpperCase().substring(0, 2);

        var card = document.createElement('div');
        card.className = 'chart-card client-card';
        card.innerHTML =
            '<div class="client-card-header">' +
                '<div class="client-avatar">' + initials + '</div>' +
                '<div class="client-info">' +
                    '<h4>' + escapeHtml(c.name) + '</h4>' +
                    '<span>' + (c.email || c.company || 'No contact info') + '</span>' +
                '</div>' +
                '<button class="btn-delete client-delete" data-id="' + c.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>' +
            '</div>' +
            '<div class="client-stats">' +
                '<div><span class="client-stat-val">' + fmt(rev) + '</span><span class="client-stat-lbl">Revenue</span></div>' +
                '<div><span class="client-stat-val">' + invCount + '</span><span class="client-stat-lbl">Invoices</span></div>' +
            '</div>';
        grid.appendChild(card);
    });

    grid.querySelectorAll('.client-delete').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            if (!confirm('Delete this client? Their invoices will remain.')) return;
            await supabase.from('clients').delete().eq('id', btn.dataset.id);
            loadClients();
        });
    });
}

// --- PROFIT & LOSS ---
var pnlBarChart = null, pnlPieChart = null, pnlTrendChart = null;

function setupPnL() {
    var filter = document.getElementById('pnlMonthFilter');
    var now = new Date();
    for (var i = 0; i < 12; i++) {
        var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        var opt = document.createElement('option');
        opt.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        opt.textContent = d.toLocaleString('default', { month: 'long', year: 'numeric' });
        filter.appendChild(opt);
    }
    filter.addEventListener('change', renderPnL);
}

function renderPnL() {
    if (accountMode !== 'business') return;
    var filterVal = document.getElementById('pnlMonthFilter').value;
    var monthKey = filterVal || (new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0'));

    var revenue = userSettings.income || 0;
    var invRevenue = invoices
        .filter(function(inv) { return inv.status === 'paid' && inv.invoice_date && inv.invoice_date.startsWith(monthKey); })
        .reduce(function(s, inv) { return s + inv.amount; }, 0);

    var monthExpenses = expenses.filter(function(e) { return e.date && e.date.startsWith(monthKey); });
    var totalExp = monthExpenses.reduce(function(s, e) { return s + e.amount; }, 0);
    var totalRevenue = revenue + invRevenue;
    var profit = totalRevenue - totalExp;
    var margin = totalRevenue > 0 ? ((profit / totalRevenue) * 100).toFixed(1) : '0.0';

    document.getElementById('pnlRevenue').textContent = fmt(totalRevenue);
    document.getElementById('pnlExpenses').textContent = fmt(totalExp);
    document.getElementById('pnlProfit').textContent = fmt(profit);
    document.getElementById('pnlProfit').style.color = profit >= 0 ? '#10b981' : '#ef4444';
    document.getElementById('pnlMargin').textContent = margin + '%';

    var catTotals = {};
    monthExpenses.forEach(function(e) {
        catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
    });
    var breakdownEl = document.getElementById('pnlBreakdown');
    breakdownEl.innerHTML = '';
    var sortedCats = Object.entries(catTotals).sort(function(a, b) { return b[1] - a[1]; });
    sortedCats.forEach(function(entry) {
        var pct = totalExp > 0 ? ((entry[1] / totalExp) * 100).toFixed(1) : 0;
        var color = businessCategoryColors[entry[0]] || categoryColors[entry[0]] || '#6b7280';
        var row = document.createElement('div');
        row.className = 'pnl-row';
        row.innerHTML =
            '<div class="pnl-row-left">' +
                '<div class="pnl-dot" style="background:' + color + '"></div>' +
                '<span>' + entry[0] + '</span>' +
            '</div>' +
            '<div class="pnl-row-right">' +
                '<div class="pnl-bar-track"><div class="pnl-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
                '<span class="pnl-amount">' + fmt(entry[1]) + '</span>' +
                '<span class="pnl-pct">' + pct + '%</span>' +
            '</div>';
        breakdownEl.appendChild(row);
    });

    var cc = chartColors();
    if (pnlBarChart) pnlBarChart.destroy();
    pnlBarChart = new Chart(document.getElementById('pnlBarChart'), {
        type: 'bar',
        data: {
            labels: ['Revenue', 'Expenses', 'Profit'],
            datasets: [{
                data: [totalRevenue, totalExp, Math.max(0, profit)],
                backgroundColor: ['rgba(16,185,129,0.7)', 'rgba(239,68,68,0.7)', 'rgba(59,130,246,0.7)'],
                borderRadius: 8
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { ticks: { color: cc.tick }, grid: { color: cc.grid } },
                x: { ticks: { color: cc.tick }, grid: { display: false } }
            }
        }
    });

    var labels = Object.keys(catTotals);
    var data = Object.values(catTotals);
    var colors = labels.map(function(l) { return businessCategoryColors[l] || categoryColors[l] || '#6b7280'; });
    if (pnlPieChart) pnlPieChart.destroy();
    pnlPieChart = new Chart(document.getElementById('pnlPieChart'), {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderWidth: 0 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: { legend: { position: 'bottom', labels: { color: cc.legendText, padding: 12, usePointStyle: true, pointStyle: 'circle' } } }
        }
    });

    var trendLabels = [], trendRevenue = [], trendExpenses = [], trendProfit = [];
    var now2 = new Date();
    for (var i = 5; i >= 0; i--) {
        var d = new Date(now2.getFullYear(), now2.getMonth() - i, 1);
        var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        trendLabels.push(d.toLocaleString('default', { month: 'short' }));
        var mExp = expenses.filter(function(e) { return e.date && e.date.startsWith(key); }).reduce(function(s, e) { return s + e.amount; }, 0);
        var mInvRev = invoices.filter(function(inv) { return inv.status === 'paid' && inv.invoice_date && inv.invoice_date.startsWith(key); }).reduce(function(s, inv) { return s + inv.amount; }, 0);
        var mRev = revenue + mInvRev;
        trendRevenue.push(mRev);
        trendExpenses.push(mExp);
        trendProfit.push(mRev - mExp);
    }
    if (pnlTrendChart) pnlTrendChart.destroy();
    pnlTrendChart = new Chart(document.getElementById('pnlTrendChart'), {
        type: 'line',
        data: {
            labels: trendLabels,
            datasets: [
                { label: 'Revenue', data: trendRevenue, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4 },
                { label: 'Expenses', data: trendExpenses, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.4 },
                { label: 'Profit', data: trendProfit, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: cc.legendText, usePointStyle: true, pointStyle: 'circle' } } },
            scales: {
                y: { ticks: { color: cc.tick }, grid: { color: cc.grid } },
                x: { ticks: { color: cc.tick }, grid: { display: false } }
            }
        }
    });
}

// --- TAX ---
function renderTax() {
    if (accountMode !== 'business') return;
    var annualRevenue = (userSettings.income || 0) * 12;
    var invRevenue = invoices.filter(function(inv) { return inv.status === 'paid'; }).reduce(function(s, inv) { return s + inv.amount; }, 0);
    annualRevenue += invRevenue;

    var annualExpenses = expenses.reduce(function(s, e) { return s + e.amount; }, 0);
    var taxableIncome = Math.max(0, annualRevenue - annualExpenses);
    var taxRate = 0.25;
    var estimatedTax = taxableIncome * taxRate;

    document.getElementById('taxRevenue').textContent = fmt(annualRevenue);
    document.getElementById('taxExpenses').textContent = fmt(annualExpenses);
    document.getElementById('taxableIncome').textContent = fmt(taxableIncome);
    document.getElementById('taxEstimate').textContent = fmt(estimatedTax);

    var tbody = document.getElementById('taxBody');
    tbody.innerHTML = '';
    var now = new Date();
    var year = now.getFullYear();
    var quarters = [
        { label: 'Q1 (Jan-Mar)', months: ['01', '02', '03'] },
        { label: 'Q2 (Apr-Jun)', months: ['04', '05', '06'] },
        { label: 'Q3 (Jul-Sep)', months: ['07', '08', '09'] },
        { label: 'Q4 (Oct-Dec)', months: ['10', '11', '12'] }
    ];
    quarters.forEach(function(q) {
        var qRev = (userSettings.income || 0) * 3;
        var qInvRev = 0, qExp = 0;
        q.months.forEach(function(m) {
            var key = year + '-' + m;
            qInvRev += invoices.filter(function(inv) { return inv.status === 'paid' && inv.invoice_date && inv.invoice_date.startsWith(key); }).reduce(function(s, inv) { return s + inv.amount; }, 0);
            qExp += expenses.filter(function(e) { return e.date && e.date.startsWith(key); }).reduce(function(s, e) { return s + e.amount; }, 0);
        });
        qRev += qInvRev;
        var qTaxable = Math.max(0, qRev - qExp);
        var qTax = qTaxable * taxRate;
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td>' + q.label + '</td>' +
            '<td>' + fmt(qRev) + '</td>' +
            '<td>' + fmt(qExp) + '</td>' +
            '<td>' + fmt(qTaxable) + '</td>' +
            '<td>' + fmt(qTax) + '</td>';
        tbody.appendChild(tr);
    });

    var deductEl = document.getElementById('taxDeductibles');
    deductEl.innerHTML = '';
    var catTotals = {};
    expenses.forEach(function(e) {
        catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
    });
    var sortedCats = Object.entries(catTotals).sort(function(a, b) { return b[1] - a[1]; });
    sortedCats.forEach(function(entry) {
        var pct = annualExpenses > 0 ? ((entry[1] / annualExpenses) * 100).toFixed(1) : 0;
        var color = businessCategoryColors[entry[0]] || categoryColors[entry[0]] || '#6b7280';
        var row = document.createElement('div');
        row.className = 'pnl-row';
        row.innerHTML =
            '<div class="pnl-row-left">' +
                '<div class="pnl-dot" style="background:' + color + '"></div>' +
                '<span>' + entry[0] + '</span>' +
            '</div>' +
            '<div class="pnl-row-right">' +
                '<div class="pnl-bar-track"><div class="pnl-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
                '<span class="pnl-amount">' + fmt(entry[1]) + '</span>' +
                '<span class="pnl-pct">' + pct + '%</span>' +
            '</div>';
        deductEl.appendChild(row);
    });
}

// --- SETUP & LOAD ---
function setupBusinessFeatures() {
    setupInvoices();
    setupClients();
    setupPnL();
}

// ==========================================
// QUICK ADD EXPENSE BAR
// ==========================================
function setupQuickAdd() {
    var btn = document.getElementById('quickAddBtn');
    if (!btn) return;
    // Auto-fill tithe in quick add
    var quickCat = document.getElementById('quickCategory');
    if (quickCat) {
        quickCat.addEventListener('change', function() {
            if (quickCat.value === 'Tithe') {
                var titheAmt = (parseFloat(userSettings.income) || 0) * 0.1;
                if (titheAmt > 0) {
                    document.getElementById('quickAmount').value = titheAmt.toFixed(2);
                    document.getElementById('quickDesc').value = 'Monthly Tithe (10%)';
                }
            }
        });
    }
    btn.addEventListener('click', async function() {
        var cat = document.getElementById('quickCategory').value;
        var amt = parseFloat(document.getElementById('quickAmount').value);
        var desc = document.getElementById('quickDesc').value.trim() || cat;
        if (!amt || amt <= 0) return;
        var expense = {
            user_id: currentUser.id,
            category: cat,
            description: desc,
            amount: amt,
            date: new Date().toISOString().split('T')[0],
            recurring: 'no',
            account_mode: accountMode
        };
        if (accountMode === 'family' && activeGroupId) {
            expense.group_id = activeGroupId;
            if (myFamilyRole === 'kid') {
                await supabase.from('family_pending').insert({
                    group_id: activeGroupId,
                    requested_by: currentUser.id,
                    requester_name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Member',
                    action: 'add_expense',
                    payload: expense
                });
                showUndoToast('Expense submitted for parent approval');
                notifyPendingSubmitted('add_expense', cat + ' — ' + fmt(amt));
                document.getElementById('quickAmount').value = '';
                document.getElementById('quickDesc').value = '';
                loadPendingApprovals();
                return;
            }
        }
        btn.disabled = true;
        var result = await supabase.from('expenses').insert(expense);
        if (result.error) {
            showUndoToast('Failed to add expense — please try again');
            console.error('Quick add error:', result.error);
            btn.disabled = false;
            return;
        }
        notifyExpenseAdded(expense);
        document.getElementById('quickAmount').value = '';
        document.getElementById('quickDesc').value = '';
        btn.disabled = false;
        loadExpenses();
    });
}

// ==========================================
// MONTH-TO-MONTH COMPARISON
// ==========================================
function renderMonthComparison() {
    var el = document.getElementById('monthComparison');
    if (!el) return;
    var now = new Date();
    var thisKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var prevKey = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');

    var thisTotal = expenses.filter(function(e) { return e.date.startsWith(thisKey); })
        .reduce(function(s, e) { return s + e.amount; }, 0);
    var prevTotal = expenses.filter(function(e) { return e.date.startsWith(prevKey); })
        .reduce(function(s, e) { return s + e.amount; }, 0);

    if (prevTotal === 0 && thisTotal === 0) {
        el.classList.add('hidden');
        return;
    }

    el.classList.remove('hidden');
    el.classList.remove('up', 'down', 'same');
    var iconEl = document.getElementById('comparisonIcon');
    var textEl = document.getElementById('comparisonText');
    var prevMonth = prev.toLocaleString('default', { month: 'long' });

    if (prevTotal === 0) {
        el.classList.add('same');
        iconEl.textContent = '\u2139\uFE0F';
        textEl.textContent = 'No data for ' + prevMonth + ' to compare';
    } else {
        var diff = thisTotal - prevTotal;
        var pct = Math.abs((diff / prevTotal) * 100).toFixed(1);
        if (diff > 0) {
            el.classList.add('up');
            iconEl.textContent = '\u2B06\uFE0F';
            textEl.textContent = 'Spending is up ' + pct + '% vs ' + prevMonth;
        } else if (diff < 0) {
            el.classList.add('down');
            iconEl.textContent = '\u2B07\uFE0F';
            textEl.textContent = 'Spending is down ' + pct + '% vs ' + prevMonth;
        } else {
            el.classList.add('same');
            iconEl.textContent = '\u2796';
            textEl.textContent = 'Same spending as ' + prevMonth;
        }
    }
}

// ==========================================
// BUDGET PROGRESS RING
// ==========================================
function renderBudgetRing() {
    var ringFill = document.getElementById('ringFill');
    if (!ringFill) return;

    var monthExp = currentMonthExpenses();
    var totalSpent = monthExp.reduce(function(s, e) { return s + e.amount; }, 0);
    var income = userSettings.income || 0;
    var remaining = income - totalSpent;

    document.getElementById('ringIncome').textContent = fmt(income);
    document.getElementById('ringSpent').textContent = fmt(totalSpent);
    document.getElementById('ringRemaining').textContent = fmt(remaining);

    var pct = income > 0 ? Math.min(100, (totalSpent / income) * 100) : 0;
    document.getElementById('ringPct').textContent = Math.round(pct) + '%';

    var circumference = 2 * Math.PI * 50; // r=50 -> 314.16
    var offset = circumference - (pct / 100) * circumference;
    ringFill.style.strokeDashoffset = offset;

    // Color based on usage: green < 60%, yellow 60-85%, red > 85%
    if (pct < 60) {
        ringFill.style.stroke = '#10b981';
    } else if (pct < 85) {
        ringFill.style.stroke = '#f59e0b';
    } else {
        ringFill.style.stroke = '#ef4444';
    }
}

// ==========================================
// ONBOARDING TOUR (first-time users)
// ==========================================
function setupOnboardingTour(forceReplay) {
    // Check localStorage as primary tour-done flag (DB column may not exist)
    var localTourDone = localStorage.getItem('bw-tour-done-' + accountMode);
    if (!forceReplay && localTourDone) return;
    // Also check DB setting as fallback
    if (userSettings.tour_done) {
        if (typeof userSettings.tour_done === 'string') {
            try { userSettings.tour_done = JSON.parse(userSettings.tour_done); } catch(e) { userSettings.tour_done = {}; }
        }
        if (!forceReplay && userSettings.tour_done[accountMode]) return;
    }
    // Skip for existing users who already have data (not a first-time user)
    if (!forceReplay && expenses.length > 0) return;
    // Only show after setup is done (income or goal configured)
    if (!forceReplay && !userSettings.income && !userSettings.savings_goal) return;

    var baseSteps = [
        { target: '.stats-grid', title: 'Your Stats', desc: 'See your income, spending, remaining budget, and savings goal at a glance.' },
        { target: '#quickAddBar', title: 'Quick Add', desc: 'Add expenses instantly without opening a form. Pick a category, enter the amount, and hit Add.' },
        { target: '#budgetRingCard', title: 'Budget Ring', desc: 'A visual gauge showing how much of your monthly budget you\'ve used. Green is good, red means watch out!' },
        { target: '.sidebar', title: 'Navigation', desc: 'Switch between Overview, Expenses, Savings Goals, Currency Converter, and more from the sidebar.' },
        { target: '#addExpenseBtn', title: 'Add Expense', desc: 'Click here to add a detailed expense with category, date, and recurring options.' }
    ];

    var businessSteps = [
        { target: '.nav-item[data-page="invoices"]', title: 'Invoices', desc: 'Create and track invoices for your clients. See which are paid, pending, or overdue.' },
        { target: '.nav-item[data-page="clients"]', title: 'Clients', desc: 'Manage your client directory. Link invoices to clients for easy tracking.' },
        { target: '.nav-item[data-page="pnl"]', title: 'Profit & Loss', desc: 'Your revenue vs expenses breakdown. See net profit by category.' },
        { target: '.nav-item[data-page="tax"]', title: 'Tax Estimator', desc: 'Quarterly tax estimates based on your revenue and deductible expenses.' },
        { target: '.nav-item.nav-business-only[data-page="family-tracking"]', title: 'Partners', desc: 'Link accounts with business partners. Share an invite code so they can sync their spending to your dashboard.' }
    ];

    var familySteps = [
        { target: '.nav-item[data-page="members"]', title: 'Family Members', desc: 'Add your household members. Each gets their own colour, role, and weekly allowance.' },
        { target: '.nav-item[data-page="allowances"]', title: 'Allowances', desc: 'Track weekly spending money. Auto-resets every Monday. Warnings at 80% usage.' },
        { target: '.nav-item[data-page="chores"]', title: 'Chores & Rewards', desc: 'Assign chores with cash rewards. Completed chores add to the member\'s allowance.' },
        { target: '.nav-item[data-page="family-goals"]', title: 'Family Goals', desc: 'Save together for big purchases. Each member can contribute.' }
    ];

    var steps = baseSteps.slice();
    if (accountMode === 'business') steps = steps.concat(businessSteps);
    if (accountMode === 'family') steps = steps.concat(familySteps);

    var currentStep = 0;
    var overlay = document.getElementById('tourOverlay');
    var spotlight = document.getElementById('tourSpotlight');
    var tooltip = document.getElementById('tourTooltip');
    var dotsContainer = document.getElementById('tourDots');

    function buildDots() {
        dotsContainer.innerHTML = '';
        steps.forEach(function(_, i) {
            var dot = document.createElement('span');
            dot.className = 'tour-dot' + (i === currentStep ? ' active' : '');
            dotsContainer.appendChild(dot);
        });
    }

    function showStep(idx) {
        currentStep = idx;
        var step = steps[idx];
        var el = document.querySelector(step.target);
        if (!el) { endTour(); return; }

        // Close sidebar if we're leaving the sidebar step
        if (step.target !== '.sidebar' && window.innerWidth <= 768) {
            var sb = document.querySelector('.sidebar');
            if (sb) sb.classList.remove('open');
            var so = document.querySelector('.sidebar-overlay');
            if (so) so.classList.remove('active');
        }

        var isFixed = window.getComputedStyle(el).position === 'fixed';

        // For the sidebar on mobile, open it first
        if (step.target === '.sidebar' && window.innerWidth <= 768) {
            el.classList.add('open');
            var sideOverlay = document.querySelector('.sidebar-overlay');
            if (sideOverlay) sideOverlay.classList.add('active');
        }

        // Scroll element into view (skip for fixed elements)
        if (!isFixed) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        setTimeout(function() {
            var rect = el.getBoundingClientRect();
            var pad = 8;
            // Fixed elements: use viewport coords only (no scroll offset)
            var scrollX = isFixed ? 0 : window.scrollX;
            var scrollY = isFixed ? 0 : window.scrollY;

            spotlight.style.position = isFixed ? 'fixed' : 'absolute';
            spotlight.style.left = (rect.left - pad) + 'px';
            spotlight.style.top = (rect.top - pad) + 'px';
            spotlight.style.width = (rect.width + pad * 2) + 'px';
            spotlight.style.height = (rect.height + pad * 2) + 'px';

            document.getElementById('tourTitle').textContent = step.title;
            document.getElementById('tourDesc').textContent = step.desc;
            document.getElementById('tourNext').textContent = idx === steps.length - 1 ? 'Finish' : 'Next';
            buildDots();

            // Position tooltip below or above target, or beside for tall elements
            tooltip.style.position = isFixed ? 'fixed' : 'absolute';
            var tooltipTop, tooltipLeft;
            if (rect.height > window.innerHeight * 0.6) {
                // Element is taller than 60% of viewport — place tooltip to the right, vertically centered
                tooltipTop = Math.max(16, (window.innerHeight - 200) / 2);
                tooltipLeft = rect.right + 16;
                if (tooltipLeft + 320 > window.innerWidth) {
                    tooltipLeft = Math.max(16, rect.left - 336);
                }
            } else {
                tooltipTop = rect.bottom + scrollY + 16;
                if (tooltipTop + 200 > window.innerHeight + scrollY) {
                    tooltipTop = rect.top + scrollY - 200;
                }
                tooltipLeft = Math.max(16, Math.min(rect.left + scrollX, window.innerWidth - 320));
            }
            tooltip.style.left = tooltipLeft + 'px';
            tooltip.style.top = tooltipTop + 'px';
        }, 350);
    }

    function endTour() {
        overlay.classList.add('hidden');
        spotlight.classList.add('hidden');
        tooltip.classList.add('hidden');
        var td = (typeof userSettings.tour_done === 'string' ? JSON.parse(userSettings.tour_done) : userSettings.tour_done) || {};
        td[accountMode] = true;
        localStorage.setItem('bw-tour-done-' + accountMode, '1');
        updateUserSetting('tour_done', td);
        // Close sidebar if we opened it during tour
        var sb = document.querySelector('.sidebar');
        if (sb) sb.classList.remove('open');
        var sideOverlay = document.querySelector('.sidebar-overlay');
        if (sideOverlay) sideOverlay.classList.remove('active');
        // Reset spotlight/tooltip positioning
        spotlight.style.position = 'absolute';
        tooltip.style.position = 'absolute';
    }

    // Start tour after a brief delay
    setTimeout(function() {
        overlay.classList.remove('hidden');
        spotlight.classList.remove('hidden');
        tooltip.classList.remove('hidden');
        showStep(0);
    }, 1500);

    // Remove old listeners by cloning elements (prevents stacking on replay)
    var oldNext = document.getElementById('tourNext');
    var newNext = oldNext.cloneNode(true);
    oldNext.parentNode.replaceChild(newNext, oldNext);
    var oldSkip = document.getElementById('tourSkip');
    var newSkip = oldSkip.cloneNode(true);
    oldSkip.parentNode.replaceChild(newSkip, oldSkip);

    newNext.addEventListener('click', function() {
        if (currentStep < steps.length - 1) {
            showStep(currentStep + 1);
        } else {
            endTour();
        }
    });

    newSkip.addEventListener('click', endTour);
    overlay.onclick = endTour;
}

// ==========================================
// GLOBAL SEARCH
// ==========================================
function setupGlobalSearch() {
    var trigger = document.getElementById('globalSearchTrigger');
    var overlay = document.getElementById('globalSearchOverlay');
    var input = document.getElementById('globalSearchInput');
    var results = document.getElementById('globalSearchResults');
    if (!trigger || !overlay) return;

    function openSearch() {
        overlay.classList.remove('hidden');
        input.value = '';
        results.innerHTML = '';
        setTimeout(function() { input.focus(); }, 100);
    }

    function closeSearch() {
        overlay.classList.add('hidden');
    }

    trigger.addEventListener('click', openSearch);
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeSearch();
    });

    document.addEventListener('keydown', function(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            if (overlay.classList.contains('hidden')) openSearch();
            else closeSearch();
        }
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeSearch();
    });

    input.addEventListener('input', function() {
        var q = input.value.trim().toLowerCase();
        results.innerHTML = '';
        if (q.length < 2) return;

        var html = '';
        // Search expenses
        var matchedExp = expenses.filter(function(e) {
            return e.description.toLowerCase().indexOf(q) !== -1 ||
                   e.category.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 5);

        if (matchedExp.length > 0) {
            html += '<div class="search-result-group">Expenses</div>';
            matchedExp.forEach(function(e) {
                var icon = categoryIcons[e.category] || '';
                html += '<div class="search-result-item" data-action="expense" data-id="' + e.id + '">' +
                    '<div class="search-result-icon" style="background:' + (categoryColors[e.category] || '#6b7280') + '20;">' + icon + '</div>' +
                    '<div class="search-result-info"><div class="search-result-title">' + escapeHtml(e.description) + '</div><div class="search-result-meta">' + e.category + ' &bull; ' + e.date + '</div></div>' +
                    '<div class="search-result-amount">' + fmt(e.amount) + '</div></div>';
            });
        }

        // Search savings goals
        var matchedGoals = savingsGoals.filter(function(g) {
            return g.name.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 3);

        if (matchedGoals.length > 0) {
            html += '<div class="search-result-group">Savings Goals</div>';
            matchedGoals.forEach(function(g) {
                html += '<div class="search-result-item" data-action="goals">' +
                    '<div class="search-result-icon" style="background:rgba(16,185,129,0.15);">&#127919;</div>' +
                    '<div class="search-result-info"><div class="search-result-title">' + escapeHtml(g.name) + '</div><div class="search-result-meta">Goal: ' + fmt(g.target_amount) + '</div></div>' +
                    '<div class="search-result-amount">' + fmt(g.saved_amount) + '</div></div>';
            });
        }

        // Search categories
        var allCats = Object.keys(categoryColors);
        var matchedCats = allCats.filter(function(c) {
            return c.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 3);

        if (matchedCats.length > 0) {
            html += '<div class="search-result-group">Categories</div>';
            matchedCats.forEach(function(c) {
                var icon = categoryIcons[c] || '';
                var total = expenses.filter(function(e) { return e.category === c; }).reduce(function(s, e) { return s + e.amount; }, 0);
                html += '<div class="search-result-item" data-action="expenses">' +
                    '<div class="search-result-icon" style="background:' + (categoryColors[c] || '#6b7280') + '20;">' + icon + '</div>' +
                    '<div class="search-result-info"><div class="search-result-title">' + c + '</div><div class="search-result-meta">Total spent across all time</div></div>' +
                    '<div class="search-result-amount">' + fmt(total) + '</div></div>';
            });
        }

        if (!html) {
            html = '<div class="search-no-results">No results for "' + escapeHtml(input.value) + '"</div>';
        }

        results.innerHTML = html;

        // Click result to navigate
        results.querySelectorAll('.search-result-item').forEach(function(item) {
            item.addEventListener('click', function() {
                var action = item.dataset.action;
                closeSearch();
                if (action === 'expense' || action === 'expenses') {
                    document.querySelector('.nav-item[data-page="expenses"]').click();
                } else if (action === 'goals') {
                    document.querySelector('.nav-item[data-page="savings"]').click();
                }
            });
        });
    });
}

// ==========================================
// SWIPE ACTIONS (Mobile Expense List)
// ==========================================
function setupSwipeActions() {
    if (!('ontouchstart' in window)) return; // Only on touch devices

    function attachSwipe(container) {
        container.querySelectorAll('tr').forEach(function(row) {
            if (row.dataset.swipeAttached) return;
            row.dataset.swipeAttached = '1';

            // Add red delete background behind the row
            row.style.position = 'relative';
            row.style.overflow = 'visible';
            row.style.willChange = 'transform, opacity';
            var bg = document.createElement('div');
            bg.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(135deg,#ef4444,#dc2626);border-radius:8px;opacity:0;transition:opacity 0.2s cubic-bezier(0.4,0,0.2,1);pointer-events:none;z-index:-1;display:flex;align-items:center;justify-content:flex-end;padding:0 16px;';
            bg.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" stroke-width="2" style="transition:transform 0.2s;"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>';
            row.appendChild(bg);
            var trashIcon = bg.querySelector('svg');

            var startX = 0, currentX = 0, isDragging = false;
            var threshold = 50;
            var raf = null;

            row.addEventListener('touchstart', function(e) {
                startX = e.touches[0].clientX;
                currentX = startX;
                isDragging = true;
                row.style.transition = 'none';
                bg.style.transition = 'none';
            }, { passive: true });

            row.addEventListener('touchmove', function(e) {
                if (!isDragging) return;
                currentX = e.touches[0].clientX;
                if (raf) return;
                raf = requestAnimationFrame(function() {
                    var dx = currentX - startX;
                    // Rubber band effect past 100px
                    var absDx = Math.abs(dx);
                    var sign = dx > 0 ? 1 : -1;
                    var clamped = absDx > 100 ? 100 + (absDx - 100) * 0.3 : absDx;
                    row.style.transform = 'translateX(' + (sign * clamped) + 'px)';
                    // Red background fades in
                    var progress = Math.min(absDx / threshold, 1);
                    bg.style.opacity = progress * 0.9;
                    // Scale up trash icon when past threshold
                    var iconScale = absDx > threshold ? 1.2 : 0.8 + (progress * 0.2);
                    trashIcon.style.transform = 'scale(' + iconScale + ')';
                    raf = null;
                });
            }, { passive: true });

            row.addEventListener('touchend', function() {
                isDragging = false;
                if (raf) { cancelAnimationFrame(raf); raf = null; }
                var dx = currentX - startX;

                if (Math.abs(dx) > threshold) {
                    // Delete with smooth slide-out and collapse
                    var direction = dx > 0 ? 1 : -1;
                    row.style.transition = 'transform 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.4s cubic-bezier(0.4,0,0.2,1)';
                    row.style.transform = 'translateX(' + (direction * 400) + 'px)';
                    row.style.opacity = '0';
                    setTimeout(function() {
                        // Collapse height smoothly
                        row.style.transition = 'max-height 0.3s cubic-bezier(0.4,0,0.2,1), padding 0.3s cubic-bezier(0.4,0,0.2,1)';
                        row.style.maxHeight = '0';
                        row.style.overflow = 'hidden';
                        Array.from(row.children).forEach(function(td) { td.style.padding = '0'; });
                        setTimeout(function() {
                            bg.style.opacity = '0';
                            row.style.cssText = '';
                            var deleteBtn = row.querySelector('.btn-delete');
                            if (deleteBtn) deleteBtn.click();
                        }, 300);
                    }, 350);
                } else {
                    // Snap back with spring
                    row.style.transition = 'transform 0.35s cubic-bezier(0.34,1.56,0.64,1)';
                    row.style.transform = 'translateX(0)';
                    bg.style.transition = 'opacity 0.25s ease';
                    bg.style.opacity = '0';
                    trashIcon.style.transform = 'scale(0.8)';
                }
                currentX = 0;
            });
        });
    }

    // Re-attach after each render
    var origRenderOverview = renderOverview;
    renderOverview = function() {
        origRenderOverview();
        var tbody = document.getElementById('recentBody');
        if (tbody) attachSwipe(tbody);
    };

    var origRenderAll = renderAllExpenses;
    renderAllExpenses = function() {
        origRenderAll();
        var tbody = document.getElementById('allExpensesBody');
        if (tbody) attachSwipe(tbody);
    };
}

// ==========================================
// RECURRING EXPENSE AUTO-DETECTION
// ==========================================
function detectRecurringExpenses() {
    var container = document.getElementById('recurringSuggestions');
    if (!container) return;
    container.innerHTML = '';

    var dismissed = (userSettings.recurring_dismissed || []).slice();

    // Group expenses by description+amount across months
    var groups = {};
    expenses.forEach(function(e) {
        if (e.recurring && e.recurring !== 'no') return;
        var key = e.category + '|' + e.description + '|' + e.amount;
        if (!groups[key]) groups[key] = { expense: e, months: new Set() };
        var month = e.date.substring(0, 7);
        groups[key].months.add(month);
    });

    var suggestions = [];
    Object.keys(groups).forEach(function(key) {
        if (groups[key].months.size >= 3 && dismissed.indexOf(key) === -1) {
            suggestions.push({ key: key, expense: groups[key].expense, count: groups[key].months.size });
        }
    });

    suggestions.slice(0, 3).forEach(function(s) {
        var div = document.createElement('div');
        div.className = 'recurring-suggestion';
        div.innerHTML =
            '<span class="recurring-suggestion-icon">&#128260;</span>' +
            '<div class="recurring-suggestion-text"><strong>' + escapeHtml(s.expense.description) + '</strong> (' + fmt(s.expense.amount) + ') appears in ' + s.count + ' months. Mark as recurring?</div>' +
            '<div class="recurring-suggestion-actions">' +
                '<button class="recurring-yes" data-key="' + escapeHtml(s.key) + '" data-cat="' + escapeHtml(s.expense.category) + '" data-desc="' + escapeHtml(s.expense.description) + '" data-amt="' + s.expense.amount + '">Yes</button>' +
                '<button class="recurring-dismiss" data-key="' + escapeHtml(s.key) + '">Dismiss</button>' +
            '</div>';
        container.appendChild(div);
    });

    container.querySelectorAll('.recurring-yes').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            // Mark all matching expenses as monthly recurring
            var cat = btn.dataset.cat;
            var desc = btn.dataset.desc;
            var amt = parseFloat(btn.dataset.amt);
            var toUpdate = expenses.filter(function(e) {
                return e.category === cat && e.description === desc && e.amount === amt && (!e.recurring || e.recurring === 'no');
            });
            for (var i = 0; i < toUpdate.length; i++) {
                toUpdate[i].recurring = 'monthly';
                await supabase.from('expenses').update({ recurring: 'monthly' }).eq('id', toUpdate[i].id);
            }
            btn.closest('.recurring-suggestion').remove();
            showUndoToast('Marked as recurring');
        });
    });

    container.querySelectorAll('.recurring-dismiss').forEach(function(btn) {
        btn.addEventListener('click', function() {
            dismissed.push(btn.dataset.key);
            updateUserSetting('recurring_dismissed', dismissed);
            btn.closest('.recurring-suggestion').remove();
        });
    });
}

// ==========================================
// BUDGET TEMPLATES (Setup)
// ==========================================
function setupBudgetTemplates() {
    var grid = document.getElementById('templateGrid');
    if (!grid) return;

    var templates = {
        student: { income: 5000, goal: 500 },
        professional: { income: 25000, goal: 5000 },
        household: { income: 40000, goal: 8000 }
    };

    grid.querySelectorAll('.template-card').forEach(function(card) {
        card.addEventListener('click', function() {
            grid.querySelectorAll('.template-card').forEach(function(c) { c.classList.remove('active'); });
            card.classList.add('active');
            var t = templates[card.dataset.template];
            if (t) {
                document.getElementById('setupIncome').value = t.income;
                document.getElementById('setupGoal').value = t.goal;
            }
        });
    });
}

// ==========================================
// EDIT FAMILY MEMBER
// ==========================================
function setupEditMember() {
    var modal = document.getElementById('editMemberModal');
    if (!modal) return;

    document.getElementById('closeEditMemberModal').addEventListener('click', function() {
        modal.classList.add('hidden');
    });

    document.getElementById('editMemberForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var id = document.getElementById('editMemberId').value;
        var member = familyMembers.find(function(m) { return m.id === id; });
        if (!member) return;
        member.name = document.getElementById('editMemberName').value.trim();
        member.role = document.getElementById('editMemberRole').value;
        member.age = document.getElementById('editMemberAge').value || null;
        member.allowance = parseFloat(document.getElementById('editMemberAllowance').value) || 0;
        supabase.from('family_members').update({
            name: member.name, role: member.role, age: member.age, allowance: member.allowance
        }).eq('id', id);
        renderMembers();
        renderAllowances();
        modal.classList.add('hidden');
    });
}

function openEditMember(memberId) {
    var member = familyMembers.find(function(m) { return m.id === memberId; });
    if (!member) return;
    document.getElementById('editMemberId').value = member.id;
    document.getElementById('editMemberName').value = member.name;
    document.getElementById('editMemberRole').value = member.role;
    document.getElementById('editMemberAge').value = member.age || '';
    document.getElementById('editMemberAllowance').value = member.allowance || 0;
    document.getElementById('editMemberModal').classList.remove('hidden');
}

// ==========================================
// ALLOWANCE AUTO-RESET
// ==========================================
function checkAllowanceReset() {
    if (accountMode !== 'family') return;
    var now = new Date();
    var startOfYear = new Date(now.getFullYear(), 0, 1);
    var weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
    var currentWeek = now.getFullYear() + '-W' + weekNum;

    if (userSettings.allowance_reset_week === currentWeek) return;

    var anyReset = false;
    familyMembers.forEach(function(m) {
        if (m.spent > 0) {
            m.spent = 0;
            anyReset = true;
        }
    });
    if (anyReset) {
        supabase.from('family_members').update({ spent: 0 }).eq('user_id', currentUser.id).gt('spent', 0);
        renderAllowances();
        renderMembers();
    }
    updateUserSetting('allowance_reset_week', currentWeek);
}

// ==========================================
// FINANCIAL TIPS FOR KIDS
// ==========================================
var kidsTips = [
    "Saving a little every week adds up to a lot over time!",
    "Before buying something, wait 24 hours. If you still want it, go for it!",
    "Try to save at least 20% of your allowance each week.",
    "Needs vs. wants: ask yourself if you really need it or just want it.",
    "Set a savings goal for something special - it makes saving fun!",
    "Comparing prices before buying can save you money.",
    "Earning money through chores teaches the value of hard work.",
    "A piggy bank is great, but a savings goal is even better!",
    "Track every purchase - you'll be surprised where your money goes.",
    "If something is on sale, it's only a deal if you actually need it.",
    "The earlier you start saving, the more you'll have when you need it.",
    "Share with others! Generosity is a great money habit."
];

function showFinancialTip() {
    var banner = document.getElementById('familyTipBanner');
    var text = document.getElementById('familyTipText');
    if (!banner || !text) return;

    var dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    text.textContent = kidsTips[dayOfYear % kidsTips.length];

    document.getElementById('dismissTip').addEventListener('click', function() {
        banner.style.display = 'none';
    });
}

// ==========================================
// PARENT NOTIFICATIONS (Allowance Warnings)
// ==========================================
function renderAllowanceWarnings() {
    var container = document.getElementById('allowanceWarnings');
    if (!container) return;
    container.innerHTML = '';

    familyMembers.forEach(function(m) {
        if (!m.allowance || m.allowance === 0) return;
        var pct = ((m.spent || 0) / m.allowance) * 100;
        if (pct >= 80) {
            var div = document.createElement('div');
            div.className = 'allowance-warning';
            div.innerHTML = '&#9888;&#65039; ' + escapeHtml(m.name) + ' has used ' + Math.round(pct) + '% of their allowance';
            container.appendChild(div);
        }
    });
}

// ==========================================
// FAMILY OVERVIEW (Spending Comparison Bars)
// ==========================================
function renderFamilyOverview() {
    var container = document.getElementById('familyOverviewBars');
    if (!container || accountMode !== 'family') return;
    container.innerHTML = '';

    if (familyMembers.length === 0) {
        container.innerHTML = '<p style="color:rgba(255,255,255,0.3);font-size:0.82rem;">Add members to see spending comparison</p>';
        return;
    }

    var maxSpent = Math.max.apply(null, familyMembers.map(function(m) { return m.spent || 0; }).concat([1]));
    var sym = getCurrencySymbol();

    familyMembers.forEach(function(m) {
        var pct = maxSpent > 0 ? ((m.spent || 0) / maxSpent) * 100 : 0;
        var div = document.createElement('div');
        div.className = 'family-bar-row';
        div.innerHTML =
            '<div class="family-bar-avatar" style="background:' + m.color + ';">' + m.name.charAt(0).toUpperCase() + '</div>' +
            '<div class="family-bar-info"><div class="family-bar-name">' + escapeHtml(m.name) + '</div>' +
            '<div class="family-bar-track"><div class="family-bar-fill" style="width:' + pct + '%;background:' + m.color + ';"></div></div></div>' +
            '<div class="family-bar-amount">' + sym + Number(m.spent || 0).toFixed(2) + '</div>';
        container.appendChild(div);
    });
}

// ==========================================
// WISH LIST
// ==========================================
function setupWishList() {
    var openBtn = document.getElementById('openWishListBtn');
    var modal = document.getElementById('wishListModal');
    var closeBtn = document.getElementById('closeWishListModal');
    if (!openBtn || !modal) return;

    openBtn.addEventListener('click', function() {
        modal.classList.remove('hidden');
        renderWishList();
    });
    closeBtn.addEventListener('click', function() { modal.classList.add('hidden'); });

    document.getElementById('addWishForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var wishes = getWishes();
        wishes.push({
            id: 'wish-' + Date.now(),
            name: document.getElementById('wishName').value.trim(),
            cost: parseFloat(document.getElementById('wishCost').value),
            saved: 0
        });
        saveWishes(wishes);
        document.getElementById('wishName').value = '';
        document.getElementById('wishCost').value = '';
        renderWishList();
    });
}

function getWishes() {
    return userSettings.wishes || [];
}

function saveWishes(wishes) {
    updateUserSetting('wishes', wishes);
}

function renderWishList() {
    var container = document.getElementById('wishListItems');
    if (!container) return;
    var wishes = getWishes();
    var sym = getCurrencySymbol();
    container.innerHTML = '';

    if (wishes.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,0.3);font-size:0.85rem;padding:20px;">No wishes yet. Add something you\'re saving for!</p>';
        return;
    }

    wishes.forEach(function(w) {
        var pct = w.cost > 0 ? Math.min(100, (w.saved / w.cost) * 100) : 0;
        var div = document.createElement('div');
        div.className = 'wish-card';
        div.innerHTML =
            '<span class="wish-icon">&#127775;</span>' +
            '<div class="wish-info"><div class="wish-name">' + escapeHtml(w.name) + '</div><div class="wish-cost">' + sym + Number(w.saved).toFixed(2) + ' / ' + sym + Number(w.cost).toFixed(2) + '</div></div>' +
            '<div class="wish-progress-mini"><div class="wish-progress-fill" style="width:' + pct + '%;"></div></div>' +
            '<div class="wish-actions">' +
                '<button class="btn-wish-save" data-id="' + w.id + '">+ Save</button>' +
                '<button class="btn-wish-delete" data-id="' + w.id + '">&times;</button>' +
            '</div>';
        container.appendChild(div);
    });

    container.querySelectorAll('.btn-wish-save').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var amount = prompt('How much to save toward this wish?');
            if (!amount || isNaN(parseFloat(amount))) return;
            var wishes = getWishes();
            var wish = wishes.find(function(w) { return w.id === btn.dataset.id; });
            if (wish) {
                wish.saved += parseFloat(amount);
                saveWishes(wishes);
                renderWishList();
                if (wish.saved >= wish.cost) {
                    showUndoToast('Wish achieved! You saved enough for ' + wish.name);
                }
            }
        });
    });

    container.querySelectorAll('.btn-wish-delete').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var wishes = getWishes().filter(function(w) { return w.id !== btn.dataset.id; });
            saveWishes(wishes);
            renderWishList();
        });
    });
}

// ==========================================
// SAVINGS LEADERBOARD
// ==========================================
function renderLeaderboard() {
    var container = document.getElementById('savingsLeaderboard');
    if (!container || familyMembers.length === 0) return;
    container.innerHTML = '';

    var sym = getCurrencySymbol();
    var sorted = familyMembers.slice().sort(function(a, b) {
        var aSaved = Math.max(0, (a.allowance || 0) - (a.spent || 0));
        var bSaved = Math.max(0, (b.allowance || 0) - (b.spent || 0));
        return bSaved - aSaved;
    });

    var medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    sorted.forEach(function(m, i) {
        var saved = Math.max(0, (m.allowance || 0) - (m.spent || 0));
        var div = document.createElement('div');
        div.className = 'leaderboard-row';
        div.innerHTML =
            '<span class="leaderboard-rank">' + (medals[i] || (i + 1)) + '</span>' +
            '<div class="leaderboard-avatar" style="background:' + m.color + ';">' + m.name.charAt(0).toUpperCase() + '</div>' +
            '<span class="leaderboard-name">' + escapeHtml(m.name) + '</span>' +
            '<span class="leaderboard-amount">' + sym + saved.toFixed(2) + '</span>';
        container.appendChild(div);
    });
}

// ==========================================
// MONTHLY FAMILY REPORT
// ==========================================
function setupFamilyReport() {
    var openBtn = document.getElementById('openFamilyReportBtn');
    var modal = document.getElementById('familyReportModal');
    var closeBtn = document.getElementById('closeFamilyReportModal');
    if (!openBtn || !modal) return;

    openBtn.addEventListener('click', function() {
        modal.classList.remove('hidden');
        generateFamilyReport();
    });
    closeBtn.addEventListener('click', function() { modal.classList.add('hidden'); });
}

function generateFamilyReport() {
    var content = document.getElementById('familyReportContent');
    if (!content) return;

    var sym = getCurrencySymbol();
    var totalBudget = userSettings.income || 0;
    var monthExp = currentMonthExpenses();
    var totalSpent = monthExp.reduce(function(s, e) { return s + e.amount; }, 0);

    var html = '<div class="report-section"><h4>Family Budget Summary</h4>';
    html += '<div class="report-row"><span class="report-row-label">Monthly Budget</span><span>' + sym + Number(totalBudget).toFixed(2) + '</span></div>';
    html += '<div class="report-row"><span class="report-row-label">Total Spent</span><span>' + sym + Number(totalSpent).toFixed(2) + '</span></div>';
    html += '<div class="report-row"><span class="report-row-label">Remaining</span><span>' + sym + Number(totalBudget - totalSpent).toFixed(2) + '</span></div>';
    html += '</div>';

    if (familyMembers.length > 0) {
        html += '<div class="report-section"><h4>Member Spending</h4>';
        var totalMemberSpent = 0;
        familyMembers.forEach(function(m) {
            var spent = m.spent || 0;
            totalMemberSpent += spent;
            var saved = Math.max(0, (m.allowance || 0) - spent);
            html += '<div class="report-row"><span class="report-row-label">' + escapeHtml(m.name) + '</span><span>Spent: ' + sym + spent.toFixed(2) + ' | Saved: ' + sym + saved.toFixed(2) + '</span></div>';
        });
        html += '</div>';

        // Chores completed
        var completedChores = familyChores.filter(function(c) { return c.completed; });
        if (completedChores.length > 0) {
            html += '<div class="report-section"><h4>Chores Completed (' + completedChores.length + ')</h4>';
            completedChores.forEach(function(c) {
                var member = familyMembers.find(function(m) { return m.id === c.assignee; });
                html += '<div class="report-row"><span class="report-row-label">' + escapeHtml(c.name) + '</span><span>' + (member ? escapeHtml(member.name) : 'Unassigned') + ' &bull; +' + sym + Number(c.reward).toFixed(2) + '</span></div>';
            });
            html += '</div>';
        }

        // Family goals progress
        if (familyGoals.length > 0) {
            html += '<div class="report-section"><h4>Family Goals Progress</h4>';
            familyGoals.forEach(function(g) {
                var pct = g.target > 0 ? Math.round((g.saved / g.target) * 100) : 0;
                html += '<div class="report-row"><span class="report-row-label">' + escapeHtml(g.name) + '</span><span>' + pct + '% (' + sym + Number(g.saved).toFixed(2) + ' / ' + sym + Number(g.target).toFixed(2) + ')</span></div>';
            });
            html += '</div>';
        }
    }

    // Top spending categories
    var catTotals = {};
    monthExp.forEach(function(e) { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });
    var sortedCats = Object.entries(catTotals).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
    if (sortedCats.length > 0) {
        html += '<div class="report-section"><h4>Top Spending Categories</h4>';
        sortedCats.forEach(function(entry) {
            html += '<div class="report-row"><span class="report-row-label">' + (categoryIcons[entry[0]] || '') + ' ' + entry[0] + '</span><span>' + sym + Number(entry[1]).toFixed(2) + '</span></div>';
        });
        html += '</div>';
    }

    content.innerHTML = html;
}

// ==========================================
// HELP PAGE (mode-specific instructions)
// ==========================================
function setupHelpPage() {
    // Show/hide mode-specific help sections
    var bizSections = document.querySelectorAll('.help-business-only');
    var famSections = document.querySelectorAll('.help-family-only');
    bizSections.forEach(function(s) { s.style.display = accountMode === 'business' ? '' : 'none'; });
    famSections.forEach(function(s) { s.style.display = accountMode === 'family' ? '' : 'none'; });

    // Replay tour button
    var replayBtn = document.getElementById('replayTourBtn');
    if (replayBtn) {
        replayBtn.addEventListener('click', function() {
            // Navigate to overview first so tour targets are visible
            document.querySelector('.nav-item[data-page="overview"]').click();
            setTimeout(function() {
                setupOnboardingTour(true);
            }, 500);
        });
    }
}

// ==========================================
// CLOSE MODALS ON OUTSIDE CLICK & NAV
// ==========================================
function setupModalAutoDismiss() {
    // Close modal when clicking overlay background
    document.querySelectorAll('.modal-overlay').forEach(function(overlay) {
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                overlay.classList.add('hidden');
            }
        });
    });

    // Close all open modals when navigating via sidebar
    document.querySelectorAll('.nav-item').forEach(function(item) {
        item.addEventListener('click', function() {
            document.querySelectorAll('.modal-overlay').forEach(function(overlay) {
                if (!overlay.classList.contains('hidden')) {
                    overlay.classList.add('hidden');
                }
            });
            // Also close global search
            var searchOverlay = document.getElementById('globalSearchOverlay');
            if (searchOverlay && !searchOverlay.classList.contains('hidden')) {
                searchOverlay.classList.add('hidden');
            }
        });
    });

    // Lock body scroll when any modal is open
    var scrollPos = 0;
    function updateBodyScroll() {
        var anyOpen = document.querySelector('.modal-overlay:not(.hidden)');
        if (anyOpen) {
            scrollPos = window.pageYOffset || document.documentElement.scrollTop;
            document.body.style.overflow = 'hidden';
            document.body.style.touchAction = 'none';
        } else {
            document.body.style.overflow = '';
            document.body.style.touchAction = '';
        }
    }

    var observer = new MutationObserver(function() { updateBodyScroll(); });
    document.querySelectorAll('.modal-overlay').forEach(function(overlay) {
        observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    });
}

// ==========================================
// PAGE MINI-TOURS (complex pages only)
// ==========================================
var pageTours = {
    'family-tracking': {
        key: 'bw-hint-tracker',
        steps: [
            { num: 1, text: '<strong>Generate a code</strong> and share it with family members who have BudgetWise' },
            { num: 2, text: 'Members enter the code to <strong>request to link</strong> their spending' },
            { num: 3, text: '<strong>Approve</strong> members, then their spending appears in your live feed' },
            { num: 4, text: 'Members choose to share <strong>all spending or specific categories</strong> only' }
        ]
    },
    'members': {
        key: 'bw-hint-members',
        steps: [
            { num: 1, text: 'Click <strong>Add Member</strong> to add parents, teens, or kids' },
            { num: 2, text: 'Each member gets a colour, role, and <strong>weekly allowance</strong>' },
            { num: 3, text: 'Use <strong>Edit</strong> to update details or <strong>Remove</strong> to delete' }
        ]
    },
    'allowances': {
        key: 'bw-hint-allowances',
        steps: [
            { num: 1, text: 'Allowances <strong>auto-reset every Monday</strong>' },
            { num: 2, text: 'Click <strong>Log Spending</strong> to record what a member spent' },
            { num: 3, text: 'Check the <strong>leaderboard</strong> to see who saved the most' }
        ]
    },
    'invoices': {
        key: 'bw-hint-invoices',
        steps: [
            { num: 1, text: 'Click <strong>New Invoice</strong> to bill a client' },
            { num: 2, text: 'Track status: <strong>Draft, Sent, Paid, or Overdue</strong>' },
            { num: 3, text: 'Paid invoices feed into your <strong>Profit & Loss</strong> automatically' }
        ]
    },
    'pnl': {
        key: 'bw-hint-pnl',
        steps: [
            { num: 1, text: 'Revenue comes from <strong>paid invoices</strong> + your monthly income' },
            { num: 2, text: 'Expenses are pulled from your <strong>Transactions</strong> page' },
            { num: 3, text: 'See your <strong>net profit</strong> and top expense categories at a glance' }
        ]
    },
    'tax': {
        key: 'bw-hint-tax',
        steps: [
            { num: 1, text: 'Estimated tax based on your <strong>revenue minus deductible expenses</strong>' },
            { num: 2, text: 'Broken down by <strong>quarter</strong> for easy planning' },
            { num: 3, text: 'Your top <strong>deductible categories</strong> are listed below' }
        ]
    }
};

function showPageHints(pageId) {
    var tour = pageTours[pageId];
    if (!tour) return;
    if (userSettings.hints_dismissed && typeof userSettings.hints_dismissed === 'string') {
        try { userSettings.hints_dismissed = JSON.parse(userSettings.hints_dismissed); } catch(e) { userSettings.hints_dismissed = {}; }
    }
    if (userSettings.hints_dismissed && userSettings.hints_dismissed[tour.key.replace('bw-hint-', '')]) return;

    var page = document.getElementById('page-' + pageId);
    if (!page) return;

    // Remove any existing hints bar
    var existing = page.querySelector('.page-hints-bar');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.className = 'page-hints-bar';

    tour.steps.forEach(function(step) {
        var div = document.createElement('div');
        div.className = 'hint-step';
        var txt = step.text;
        if (pageId === 'family-tracking' && accountMode === 'business') {
            txt = txt.replace('family members', 'business partners');
        }
        div.innerHTML = '<span class="hint-step-num">' + step.num + '</span><span>' + txt + '</span>';
        bar.appendChild(div);
    });

    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'hint-dismiss-all';
    dismissBtn.textContent = 'Got it';
    dismissBtn.addEventListener('click', function() {
        bar.style.transition = 'opacity 0.3s, transform 0.3s';
        bar.style.opacity = '0';
        bar.style.transform = 'translateY(-10px)';
        setTimeout(function() { bar.remove(); }, 300);
        var hd = userSettings.hints_dismissed || {};
        hd[tour.key.replace('bw-hint-', '')] = true;
        updateUserSetting('hints_dismissed', hd);
    });
    bar.appendChild(dismissBtn);

    // Insert after the page header
    var header = page.querySelector('.page-header');
    if (header && header.nextSibling) {
        header.parentNode.insertBefore(bar, header.nextSibling);
    } else {
        page.insertBefore(bar, page.firstChild);
    }
}

// ==========================================
// FAMILY SPENDING TRACKER
// ==========================================
var familyGroup = null;
var familyLink = null;

function updateTrackingLabels() {
    var isBiz = accountMode === 'business';
    var pageHeader = document.querySelector('#page-family-tracking .page-header h1');
    if (pageHeader) pageHeader.textContent = isBiz ? 'Partner Tracker' : 'Spending Tracker';
    var pageSub = document.querySelector('#page-family-tracking .page-subtitle');
    if (pageSub) pageSub.textContent = isBiz ? 'Link accounts with your business partners' : 'Track real spending from linked family members';
    var inviteTitle = document.querySelector('#trackingParentView .chart-card h3');
    if (inviteTitle) inviteTitle.textContent = isBiz ? 'Your Business Invite Code' : 'Your Family Invite Code';
    var inviteDesc = inviteTitle ? inviteTitle.nextElementSibling : null;
    if (inviteDesc && inviteDesc.tagName === 'P') inviteDesc.textContent = isBiz
        ? 'Share this code with business partners. They enter it in their app to link their spending to your business dashboard.'
        : 'Share this code with family members. They enter it in their app to link their spending to your family dashboard.';
    var incomeTitle = document.querySelector('#familyIncomeSection h3');
    if (incomeTitle) incomeTitle.textContent = isBiz ? 'Combined Revenue' : 'Family Income';
    var incomeDesc = incomeTitle ? incomeTitle.nextElementSibling : null;
    if (incomeDesc && incomeDesc.tagName === 'P') incomeDesc.textContent = isBiz
        ? 'Combined revenue from all partners. Each partner sets their own contribution.'
        : 'Combined income from all family members. Each parent sets their own contribution.';
    var membersTitle = document.querySelector('#linkedMembersList').parentElement.querySelector('h3');
    if (membersTitle) membersTitle.textContent = isBiz ? 'Linked Partners' : 'Linked Members';
    var membersDesc = membersTitle ? membersTitle.nextElementSibling : null;
    if (membersDesc && membersDesc.tagName === 'P') membersDesc.textContent = isBiz
        ? 'Business partners linked to this group. Owner can manage roles and approve access.'
        : 'Family members linked to this group. Owner can manage roles and approve access.';
    var feedTitle = document.querySelector('#familySpendingFeed').parentElement.querySelector('h3');
    if (feedTitle) feedTitle.textContent = isBiz ? 'Partner Spending Feed' : 'Family Spending Feed';
    var joinTitle = document.querySelector('#trackingMemberView .chart-card h3');
    if (joinTitle) joinTitle.textContent = isBiz ? 'Join a Business' : 'Join a Family';
    var joinDesc = joinTitle ? joinTitle.nextElementSibling : null;
    if (joinDesc && joinDesc.tagName === 'P') joinDesc.textContent = isBiz
        ? 'Enter the invite code from the business owner to link your spending.'
        : 'Enter the invite code from your parent/guardian to link your spending.';
    var sharingDesc = document.querySelector('#sharingPrefsCard > p');
    if (sharingDesc) sharingDesc.textContent = isBiz
        ? 'Choose what spending data to share with your business partners.'
        : 'Choose what spending data to share with your family.';
    var enableLabel = document.querySelector('#sharingEnabled');
    if (enableLabel) {
        var labelDiv = enableLabel.closest('label').querySelector('div > div:last-child');
        if (labelDiv) labelDiv.textContent = isBiz
            ? 'When on, your expenses are visible to your business admin'
            : 'When on, your expenses are visible to your family admin';
    }
}

function setupFamilyTracking() {
    if (accountMode !== 'family' && accountMode !== 'business') return;
    updateTrackingLabels();

    // Generate invite code
    var genBtn = document.getElementById('generateCodeBtn');
    var copyBtn = document.getElementById('copyCodeBtn');
    if (genBtn) genBtn.addEventListener('click', generateFamilyCode);
    if (copyBtn) copyBtn.addEventListener('click', function() {
        var code = document.getElementById('familyInviteCode').textContent;
        if (code && code !== '------') {
            navigator.clipboard.writeText(code);
            showUndoToast('Code copied!');
        }
    });

    // Join family
    var joinBtn = document.getElementById('joinFamilyBtn');
    if (joinBtn) joinBtn.addEventListener('click', joinFamily);

    // Unlink
    var unlinkBtn = document.getElementById('unlinkBtn');
    if (unlinkBtn) unlinkBtn.addEventListener('click', unlinkFromFamily);

    // Sharing toggle
    var sharingToggle = document.getElementById('sharingEnabled');
    if (sharingToggle) sharingToggle.addEventListener('change', function() {
        var opts = document.getElementById('shareOptions');
        if (opts) opts.style.display = sharingToggle.checked ? '' : 'none';
    });

    // Share scope radio
    document.querySelectorAll('input[name="shareScope"]').forEach(function(r) {
        r.addEventListener('change', function() {
            var catList = document.getElementById('categoryShareList');
            if (catList) catList.style.display = r.value === 'selected' ? '' : 'none';
        });
    });

    // Save sharing prefs
    var saveBtn = document.getElementById('saveSharingBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveSharingPrefs);

    // Load existing state
    loadTrackingState();
}

async function generateFamilyCode() {
    var genBtn = document.getElementById('generateCodeBtn');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating...'; }

    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

    // Show code instantly so UI feels fast
    document.getElementById('familyInviteCode').textContent = code;

    var groupName = accountMode === 'business'
        ? (userSettings.company_name || 'Business')
        : (userSettings.family_name || 'Family');
    var ownerName = accountMode === 'business'
        ? (userSettings.company_name || 'Owner')
        : (userSettings.family_name || 'Owner');
    var ownerIncome = accountMode === 'business'
        ? (userSettings.biz_income || userSettings.income || 0)
        : (userSettings.fam_income || userSettings.income || 0);

    try {
        // Check existing group + existing owner link in parallel
        var existingResult = await supabase.from('family_groups')
            .select('*').eq('owner_id', currentUser.id).order('created_at', { ascending: false }).limit(1);
        var existing = existingResult.data && existingResult.data.length > 0 ? existingResult.data[0] : null;

        if (existing) {
            // Update code + check owner link in parallel
            var parallel = await Promise.all([
                supabase.from('family_groups')
                    .update({ family_code: code, family_name: groupName })
                    .eq('id', existing.id),
                supabase.from('family_links')
                    .select('id').eq('group_id', existing.id).eq('user_id', currentUser.id).maybeSingle()
            ]);
            familyGroup = Object.assign(existing, { family_code: code });
            if (!parallel[1].data) {
                await supabase.from('family_links').insert({
                    group_id: existing.id, user_id: currentUser.id,
                    display_name: ownerName, sharing_enabled: true, share_all: true,
                    approved: true, role: 'owner', income_contribution: ownerIncome
                });
            }
        } else {
            var result = await supabase.from('family_groups').insert({
                owner_id: currentUser.id, family_code: code, family_name: groupName
            }).select().single();
            if (result.data) {
                familyGroup = result.data;
                // New group always needs owner link — no need to check
                await supabase.from('family_links').insert({
                    group_id: familyGroup.id, user_id: currentUser.id,
                    display_name: ownerName, sharing_enabled: true, share_all: true,
                    approved: true, role: 'owner', income_contribution: ownerIncome
                });
            }
        }

        if (familyGroup) {
            activeGroupId = familyGroup.id;
            myFamilyRole = 'owner';
            updateTrackingViews();
        }

        showUndoToast('Invite code generated!');
    } catch(e) {
        console.error('Generate code error:', e);
        showUndoToast('Error saving code — try again');
    } finally {
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = 'Generate Code'; }
    }
}

// After generating, hide the member join view since user is now an owner
function updateTrackingViews() {
    if (myFamilyRole === 'owner' || myFamilyRole === 'parent' || myFamilyRole === 'partner') {
        document.getElementById('trackingParentView').style.display = '';
        document.getElementById('trackingMemberView').style.display = 'none';
    }
}

async function joinFamily() {
    var code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
    var errorEl = document.getElementById('joinError');
    if (code.length < 4) { errorEl.textContent = 'Code too short'; return; }

    try {
        // Find the group
        var group = await supabase.from('family_groups')
            .select('*').eq('family_code', code).maybeSingle();

        var isBiz = accountMode === 'business';
        if (!group.data) {
            errorEl.textContent = isBiz ? 'Invalid code. Check with the business owner.' : 'Invalid code. Check with your family admin.';
            return;
        }

        if (group.data.owner_id === currentUser.id) {
            errorEl.textContent = isBiz ? 'You can\'t join your own business group!' : 'You can\'t join your own family group!';
            return;
        }

        // Check if already linked
        var existingLink = await supabase.from('family_links')
            .select('*').eq('group_id', group.data.id).eq('user_id', currentUser.id).maybeSingle();

        if (existingLink.data) {
            errorEl.textContent = isBiz ? 'You\'re already linked to this business.' : 'You\'re already linked to this family.';
            return;
        }

        var meta = currentUser.user_metadata || {};
        var name = meta.full_name || meta.name || (currentUser.email ? currentUser.email.split('@')[0] : 'Member');
        var joinRole = isBiz ? 'partner' : 'kid';
        var joinIncome = isBiz ? (userSettings.biz_income || 0) : 0;

        await supabase.from('family_links').insert({
            group_id: group.data.id,
            user_id: currentUser.id,
            display_name: name,
            sharing_enabled: true,
            share_all: true,
            approved: false,
            role: joinRole,
            income_contribution: joinIncome
        });

        familyLink = { group_id: group.data.id, role: joinRole };
        activeGroupId = group.data.id;
        myFamilyRole = joinRole;
        errorEl.textContent = '';

        // Sync group name to user settings
        var parentFamilyName = group.data.family_name || (isBiz ? 'Business' : 'Family');
        if (isBiz) {
            await updateUserSettings({
                company_name: parentFamilyName
            });
        } else {
            await updateUserSettings({
                family_name_backup: userSettings.family_name || '',
                family_name: parentFamilyName
            });
        }
        // Update sidebar and welcome message
        var sideLabel = document.getElementById('currentModeLabel');
        if (sideLabel) sideLabel.textContent = parentFamilyName;
        updateWelcomeGreeting();

        showMemberLinkedUI(parentFamilyName, false);
        showUndoToast('Linked! Waiting for approval.');
    } catch(e) {
        errorEl.textContent = isBiz ? 'Error joining business. Try again.' : 'Error joining family. Try again.';
        console.error('Join error:', e);
    }
}

async function unlinkFromFamily() {
    var isBiz = accountMode === 'business';
    var confirmMsg = isBiz ? 'Unlink from this business? They will no longer see your spending.' : 'Unlink from this family? They will no longer see your spending.';
    if (!confirm(confirmMsg)) return;
    try {
        await supabase.from('family_spending').delete().eq('user_id', currentUser.id);
        await supabase.from('family_links').delete().eq('user_id', currentUser.id);
        familyLink = null;
        document.getElementById('joinSection').style.display = '';
        document.getElementById('linkedStatus').style.display = 'none';
        document.getElementById('sharingPrefsCard').style.display = 'none';

        // Restore original name
        if (!isBiz) {
            var backup = userSettings.family_name_backup;
            if (backup) {
                await updateUserSettings({ family_name: backup, family_name_backup: null });
            }
        }
        var sideLabel = document.getElementById('currentModeLabel');
        if (sideLabel) sideLabel.textContent = isBiz ? (userSettings.company_name || 'BudgetWise Pro') : (userSettings.family_name || 'Family');
        updateWelcomeGreeting();

        showUndoToast(isBiz ? 'Unlinked from business' : 'Unlinked from family');
        // Reload tracking state to show correct views
        await loadTrackingState();
    } catch(e) {
        console.error('Unlink error:', e);
    }
}

function showMemberLinkedUI(familyName, approved) {
    document.getElementById('joinSection').style.display = 'none';
    document.getElementById('linkedStatus').style.display = '';
    document.getElementById('linkedFamilyName').textContent = familyName;
    document.getElementById('linkedStatusText').textContent = approved ? 'Approved - sharing active' : 'Waiting for approval...';
    document.getElementById('sharingPrefsCard').style.display = approved ? '' : 'none';
}

async function saveSharingPrefs() {
    var enabled = document.getElementById('sharingEnabled').checked;
    var shareAll = document.querySelector('input[name="shareScope"][value="all"]').checked;
    var selectedCats = [];

    if (!shareAll) {
        document.querySelectorAll('#categoryShareList input[type="checkbox"]:checked').forEach(function(cb) {
            selectedCats.push(cb.value);
        });
    }

    try {
        await supabase.from('family_links')
            .update({
                sharing_enabled: enabled,
                share_all: shareAll,
                share_categories: selectedCats
            })
            .eq('user_id', currentUser.id);

        // If sharing enabled, sync current month expenses
        if (enabled) {
            await syncSpendingToFamily();
        }

        showUndoToast('Sharing preferences saved');
    } catch(e) {
        console.error('Save sharing error:', e);
    }
}

async function syncSpendingToFamily() {
    // Get user's link to find group_id
    var linkResult = await supabase.from('family_links')
        .select('*').eq('user_id', currentUser.id).order('joined_at', { ascending: false }).limit(1);
    var link = { data: linkResult.data && linkResult.data.length > 0 ? linkResult.data[0] : null };
    if (!link.data || !link.data.sharing_enabled || !link.data.approved) return;

    var now = new Date();
    var thisKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var monthExpenses = expenses.filter(function(e) { return e.date.startsWith(thisKey); });

    // Filter by categories if not sharing all
    if (!link.data.share_all && link.data.share_categories && link.data.share_categories.length > 0) {
        var allowedCats = link.data.share_categories;
        monthExpenses = monthExpenses.filter(function(e) {
            return allowedCats.indexOf(e.category) !== -1;
        });
    }

    // Delete old synced data for this month, then insert fresh
    await supabase.from('family_spending')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('group_id', link.data.group_id)
        .gte('date', thisKey + '-01');

    if (monthExpenses.length > 0) {
        var rows = monthExpenses.map(function(e) {
            return {
                group_id: link.data.group_id,
                user_id: currentUser.id,
                category: e.category,
                description: e.description,
                amount: e.amount,
                date: e.date
            };
        });
        await supabase.from('family_spending').insert(rows);
    }
}

async function loadTrackingState() {
    try {
        // Check if user owns a group (parent view) — use limit 1 to handle multiple rows
        var ownedResult = await supabase.from('family_groups')
            .select('*').eq('owner_id', currentUser.id).order('created_at', { ascending: false }).limit(1);
        var ownedGroup = { data: ownedResult.data && ownedResult.data.length > 0 ? ownedResult.data[0] : null };

        if (ownedGroup.data) {
            familyGroup = ownedGroup.data;
            activeGroupId = ownedGroup.data.id;
            myFamilyRole = 'owner';
            document.getElementById('familyInviteCode').textContent = ownedGroup.data.family_code;
            document.getElementById('trackingParentView').style.display = '';
            document.getElementById('trackingMemberView').style.display = 'none';
            await Promise.all([loadLinkedMembers(), loadFamilySpendingFeed(), loadPendingApprovals()]);
            applyFamilyRoleUI();
            return;
        }

        // Check if user is linked as a member
        var myLinkResult = await supabase.from('family_links')
            .select('*, family_groups(family_name)').eq('user_id', currentUser.id).order('joined_at', { ascending: false }).limit(1);
        var myLink = { data: myLinkResult.data && myLinkResult.data.length > 0 ? myLinkResult.data[0] : null };

        if (myLink.data) {
            familyLink = myLink.data;
            activeGroupId = myLink.data.group_id;
            myFamilyRole = myLink.data.role || 'kid';
            var famName = myLink.data.family_groups ? myLink.data.family_groups.family_name : (accountMode === 'business' ? 'Business' : 'Family');

            // Keep group name in sync
            if (accountMode === 'business') {
                if (userSettings.company_name !== famName) {
                    await updateUserSettings({ company_name: famName });
                    var sideLabel = document.getElementById('currentModeLabel');
                    if (sideLabel) sideLabel.textContent = famName;
                    updateWelcomeGreeting();
                }
            } else {
                var currentFamName = userSettings.family_name;
                if (currentFamName !== famName) {
                    var syncPatch = { family_name: famName };
                    if (!userSettings.family_name_backup) {
                        syncPatch.family_name_backup = currentFamName || '';
                    }
                    await updateUserSettings(syncPatch);
                    var sideLabel2 = document.getElementById('currentModeLabel');
                    if (sideLabel2) sideLabel2.textContent = famName;
                    updateWelcomeGreeting();
                }
            }

            // Parents/partners see parent view, kids see member view
            if (myFamilyRole === 'parent' || myFamilyRole === 'partner') {
                document.getElementById('trackingParentView').style.display = '';
                document.getElementById('trackingMemberView').style.display = 'none';
                // Load the group code for parents to also share
                var parentGroup = await supabase.from('family_groups')
                    .select('*').eq('id', activeGroupId).maybeSingle();
                if (parentGroup.data) {
                    familyGroup = parentGroup.data;
                    document.getElementById('familyInviteCode').textContent = parentGroup.data.family_code;
                }
                await Promise.all([loadLinkedMembers(), loadFamilySpendingFeed(), loadPendingApprovals()]);
            } else {
                // Kid view
                document.getElementById('trackingParentView').style.display = 'none';
                document.getElementById('trackingMemberView').style.display = '';
                showMemberLinkedUI(famName, myLink.data.approved);

                // Set sharing toggle state
                var sharingEl = document.getElementById('sharingEnabled');
                if (sharingEl) sharingEl.checked = myLink.data.sharing_enabled;
                var shareOpts = document.getElementById('shareOptions');
                if (shareOpts && myLink.data.sharing_enabled) shareOpts.style.display = '';
                if (!myLink.data.share_all) {
                    var selRadio = document.querySelector('input[name="shareScope"][value="selected"]');
                    if (selRadio) selRadio.checked = true;
                    buildCategoryShareList(myLink.data.share_categories || []);
                    var catList = document.getElementById('categoryShareList');
                    if (catList) catList.style.display = '';
                }

                loadMyPendingItems();
            }

            applyFamilyRoleUI();
            return;
        }

        // Neither — show both views, parent by default
        activeGroupId = null;
        myFamilyRole = null;
        document.getElementById('trackingParentView').style.display = '';
        document.getElementById('trackingMemberView').style.display = '';
    } catch(e) {
        console.warn('Family tracking load error:', e);
    }
}

// Helper: check if current user can edit in family mode
function canFamilyEdit() {
    if (accountMode !== 'family' && accountMode !== 'business') return true;
    return myFamilyRole === 'owner' || myFamilyRole === 'parent' || myFamilyRole === 'partner';
}

// Apply role-based UI restrictions in family mode
function applyFamilyRoleUI() {
    if (accountMode !== 'family' && accountMode !== 'business') return;
    var isKid = myFamilyRole === 'kid';

    // Hide delete buttons for kids
    document.querySelectorAll('.btn-delete-expense, .btn-remove-member, .btn-delete-chore, .btn-goal-delete').forEach(function(btn) {
        if (isKid) btn.style.display = 'none';
    });

    // Show pending badge for kids
    var pendingBadge = document.getElementById('pendingBadge');
    if (pendingBadge) pendingBadge.style.display = isKid ? '' : 'none';

    // Show income contribution section for parents/owner
    var incomeSection = document.getElementById('familyIncomeSection');
    if (incomeSection) incomeSection.style.display = (myFamilyRole === 'owner' || myFamilyRole === 'parent') ? '' : 'none';
}

// Load pending approvals for owner/parent
async function loadPendingApprovals() {
    if (!activeGroupId || myFamilyRole === 'kid') return;
    var container = document.getElementById('pendingApprovalsList');
    if (!container) return;

    var result = await supabase.from('family_pending')
        .select('*')
        .eq('group_id', activeGroupId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

    var items = result.data || [];
    var wrapper = document.getElementById('pendingApprovalsCard');
    if (wrapper) wrapper.style.display = items.length > 0 ? '' : 'none';

    if (items.length === 0) {
        container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;">No pending requests</p>';
        return;
    }

    container.innerHTML = items.map(function(item) {
        var desc = '';
        var p = item.payload || {};
        if (item.action === 'add_expense') desc = 'Expense: ' + (p.category || '') + ' — ' + fmt(p.amount || 0) + (p.description ? ' (' + escapeHtml(p.description) + ')' : '');
        else if (item.action === 'add_member') desc = 'New member: ' + escapeHtml(p.name || '');
        else if (item.action === 'add_chore') desc = 'New chore: ' + escapeHtml(p.name || '') + ' — ' + fmt(p.reward || 0);
        else if (item.action === 'add_goal') desc = 'New goal: ' + escapeHtml(p.name || '') + ' — ' + fmt(p.target || 0);
        else desc = item.action;

        return '<div class="pending-item" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">' +
            '<div style="flex:1;">' +
                '<div style="font-size:0.85rem;font-weight:500;">' + desc + '</div>' +
                '<div style="font-size:0.75rem;color:var(--text-secondary);">Requested by ' + escapeHtml(item.requester_name || 'Member') + ' — ' + new Date(item.created_at).toLocaleDateString() + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
                '<button class="btn-approve-pending" data-id="' + item.id + '" style="background:#10b981;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:0.78rem;cursor:pointer;">Approve</button>' +
                '<button class="btn-reject-pending" data-id="' + item.id + '" style="background:#ef4444;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:0.78rem;cursor:pointer;">Reject</button>' +
            '</div>' +
        '</div>';
    }).join('');

    // Approve handlers
    container.querySelectorAll('.btn-approve-pending').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            await approvePendingItem(btn.dataset.id);
        });
    });
    // Reject handlers
    container.querySelectorAll('.btn-reject-pending').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            await supabase.from('family_pending')
                .update({ status: 'rejected', reviewed_by: currentUser.id, reviewed_at: new Date().toISOString() })
                .eq('id', btn.dataset.id);
            notifyPendingReviewed('rejected', 'A pending request');
            showUndoToast('Request rejected');
            loadPendingApprovals();
        });
    });
}

// Approve a pending item — insert the real record from payload
// Whitelist allowed fields for each action type to prevent payload injection
function sanitizePendingPayload(action, payload, requestedBy) {
    if (action === 'add_expense') {
        return {
            user_id: requestedBy,
            category: String(payload.category || ''),
            description: String(payload.description || ''),
            amount: Math.abs(parseFloat(payload.amount) || 0),
            date: String(payload.date || new Date().toISOString().split('T')[0]),
            recurring: String(payload.recurring || 'no'),
            account_mode: payload.account_mode === 'family' ? 'family' : 'personal',
            group_id: payload.group_id || null
        };
    } else if (action === 'add_member') {
        return {
            user_id: requestedBy,
            name: String(payload.name || ''),
            role: String(payload.role || 'kid'),
            age: payload.age ? String(payload.age) : null,
            allowance: Math.abs(parseFloat(payload.allowance) || 0)
        };
    } else if (action === 'add_chore') {
        return {
            user_id: requestedBy,
            name: String(payload.name || ''),
            assignee: payload.assignee || null,
            frequency: String(payload.frequency || 'daily'),
            reward: Math.abs(parseFloat(payload.reward) || 0)
        };
    } else if (action === 'add_goal') {
        return {
            user_id: requestedBy,
            name: String(payload.name || ''),
            target: Math.abs(parseFloat(payload.target) || 0),
            saved: 0
        };
    }
    return null;
}

async function approvePendingItem(pendingId) {
    var result = await supabase.from('family_pending')
        .select('*').eq('id', pendingId).single();
    var item = result.data;
    if (!item) return;

    var safePayload = sanitizePendingPayload(item.action, item.payload || {}, item.requested_by);
    if (!safePayload) { showUndoToast('Unknown request type'); return; }

    try {
        var insertResult;
        if (item.action === 'add_expense') {
            insertResult = await supabase.from('expenses').insert(safePayload);
        } else if (item.action === 'add_member') {
            insertResult = await supabase.from('family_members').insert(safePayload);
        } else if (item.action === 'add_chore') {
            insertResult = await supabase.from('family_chores').insert(safePayload);
        } else if (item.action === 'add_goal') {
            insertResult = await supabase.from('family_goals').insert(safePayload);
        }

        if (insertResult && insertResult.error) {
            console.error('Approve insert error:', insertResult.error);
            showUndoToast('Error: ' + (insertResult.error.message || 'Could not approve'));
            return;
        }

        await supabase.from('family_pending')
            .update({ status: 'approved', reviewed_by: currentUser.id, reviewed_at: new Date().toISOString() })
            .eq('id', pendingId);

        var p = item.payload || {};
        var approveDesc = item.action === 'add_expense' ? (p.category || '') + ' ' + fmt(p.amount || 0) : (p.name || item.action);
        notifyPendingReviewed('approved', approveDesc);
        showUndoToast('Approved!');
        loadPendingApprovals();
        loadExpenses();
        loadFamilyData();
    } catch(e) {
        console.error('Approve error:', e);
        showUndoToast('Error approving request');
    }
}

// Load kid's own pending items
async function loadMyPendingItems() {
    if (myFamilyRole !== 'kid' || !activeGroupId) return;
    var container = document.getElementById('myPendingList');
    if (!container) return;

    var result = await supabase.from('family_pending')
        .select('*')
        .eq('group_id', activeGroupId)
        .eq('requested_by', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(20);

    var items = result.data || [];
    if (items.length === 0) {
        container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;">No pending requests</p>';
        return;
    }

    container.innerHTML = items.map(function(item) {
        var p = item.payload || {};
        var desc = item.action === 'add_expense' ? (p.category || '') + ' — ' + fmt(p.amount || 0) : (p.name || item.action);
        var statusColor = item.status === 'pending' ? '#f59e0b' : item.status === 'approved' ? '#10b981' : '#ef4444';
        var statusText = item.status.charAt(0).toUpperCase() + item.status.slice(1);
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">' +
            '<div style="font-size:0.85rem;">' + escapeHtml(desc) + '</div>' +
            '<span style="font-size:0.75rem;color:' + statusColor + ';font-weight:600;">' + statusText + '</span>' +
        '</div>';
    }).join('');
}

function buildCategoryShareList(selected) {
    var container = document.getElementById('categoryShareList');
    if (!container) return;
    container.innerHTML = '';
    var cats = Object.keys(categoryColors);
    cats.forEach(function(c) {
        var checked = selected.indexOf(c) !== -1 ? ' checked' : '';
        var label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.82rem;cursor:pointer;';
        label.innerHTML = '<input type="checkbox" value="' + c + '"' + checked + ' style="accent-color:#10b981;width:16px;height:16px;">' +
            (categoryIcons[c] || '') + ' ' + c;
        container.appendChild(label);
    });
}

async function loadLinkedMembers() {
    var gid = activeGroupId || (familyGroup ? familyGroup.id : null);
    if (!gid) return;
    var result = await supabase.from('family_links')
        .select('*').eq('group_id', gid).order('joined_at');
    var container = document.getElementById('linkedMembersList');
    if (!container) return;
    container.innerHTML = '';
    familyLinkMembers = result.data || [];

    var isBiz = accountMode === 'business';

    if (familyLinkMembers.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px;"><p>No ' + (isBiz ? 'partners' : 'members') + ' linked yet. Share your invite code to get started.</p></div>';
        return;
    }

    // Calculate joint income from all members
    var jointIncome = 0;
    familyLinkMembers.forEach(function(link) {
        jointIncome += Number(link.income_contribution) || 0;
    });

    // Show income summary
    var incomeSummary = document.getElementById('familyIncomeSummary');
    if (incomeSummary) {
        var incomeLabel = isBiz ? 'Combined Revenue: ' : 'Family Income: ';
        var incomeHtml = '<div style="font-weight:600;font-size:0.95rem;margin-bottom:8px;">' + incomeLabel + fmt(jointIncome) + '</div>';
        familyLinkMembers.forEach(function(link) {
            if (link.income_contribution > 0) {
                incomeHtml += '<div style="font-size:0.8rem;color:var(--text-secondary);">' + escapeHtml(link.display_name) + ': ' + fmt(link.income_contribution) + '</div>';
            }
        });
        incomeSummary.innerHTML = incomeHtml;
    }

    var isOwner = myFamilyRole === 'owner';

    familyLinkMembers.forEach(function(link) {
        var div = document.createElement('div');
        div.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;margin-bottom:8px;flex-wrap:wrap;';
        var statusColor = link.approved ? '#10b981' : '#f59e0b';
        var roleBadge = link.role === 'owner' ? 'Owner' : link.role === 'parent' ? (isBiz ? 'Partner' : 'Parent') : (isBiz ? 'Member' : 'Kid');
        var roleColor = link.role === 'owner' ? '#8b5cf6' : link.role === 'parent' ? '#3b82f6' : '#f59e0b';
        var statusText = link.approved ? roleBadge : 'Pending approval';
        var incomeText = link.income_contribution > 0 ? ' — ' + fmt(link.income_contribution) + '/mo' : '';

        var roleOpt1 = isBiz ? 'Member' : 'Kid';
        var roleOpt2 = isBiz ? 'Partner' : 'Parent';
        var actionsHtml = '';
        if (isOwner && link.role !== 'owner') {
            actionsHtml += '<select class="role-select" data-id="' + link.id + '" style="padding:4px 8px;border-radius:6px;font-size:0.75rem;border:1px solid var(--border);background:var(--card-bg);color:var(--text-primary);">' +
                '<option value="kid"' + (link.role === 'kid' ? ' selected' : '') + '>' + roleOpt1 + '</option>' +
                '<option value="parent"' + (link.role === 'parent' ? ' selected' : '') + '>' + roleOpt2 + '</option>' +
            '</select>';
            if (!link.approved) {
                actionsHtml += '<button class="btn-primary" data-id="' + link.id + '" data-action="approve" style="padding:6px 12px;font-size:0.75rem;">Approve</button>';
            } else {
                actionsHtml += '<button class="btn-primary" data-id="' + link.id + '" data-action="revoke" style="padding:6px 12px;font-size:0.75rem;background:rgba(239,68,68,0.12);color:#ef4444;">Remove</button>';
            }
        }

        div.innerHTML =
            '<div style="width:36px;height:36px;border-radius:50%;background:' + statusColor + ';display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;color:#fff;">' + link.display_name.charAt(0).toUpperCase() + '</div>' +
            '<div style="flex:1;">' +
                '<div style="font-weight:600;font-size:0.88rem;">' + escapeHtml(link.display_name) +
                    '<span style="font-size:0.7rem;background:' + roleColor + ';color:#fff;padding:2px 6px;border-radius:4px;margin-left:6px;">' + roleBadge + '</span>' +
                '</div>' +
                '<div style="font-size:0.75rem;color:var(--text-secondary);">' + statusText + incomeText + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;align-items:center;">' + actionsHtml + '</div>';
        container.appendChild(div);
    });

    // Role change handlers
    container.querySelectorAll('.role-select').forEach(function(sel) {
        sel.addEventListener('change', async function() {
            await supabase.from('family_links').update({ role: sel.value }).eq('id', sel.dataset.id);
            var roleLabel = sel.value === 'kid' ? (isBiz ? 'Member' : 'Kid') : sel.value === 'parent' ? (isBiz ? 'Partner' : 'Parent') : sel.value;
            showUndoToast('Role updated to ' + roleLabel);
            loadLinkedMembers();
        });
    });

    // Approve/Revoke handlers
    container.querySelectorAll('button[data-action]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
            var action = btn.dataset.action;
            if (action === 'approve') {
                await supabase.from('family_links').update({ approved: true }).eq('id', btn.dataset.id);
                showUndoToast('Member approved!');
            } else if (action === 'revoke') {
                if (!confirm(isBiz ? 'Remove this member from the business group?' : 'Remove this member from the family group?')) return;
                await supabase.from('family_links').delete().eq('id', btn.dataset.id);
                showUndoToast('Member removed');
            }
            loadLinkedMembers();
            loadFamilySpendingFeed();
        });
    });
}

async function loadFamilySpendingFeed() {
    if (!familyGroup) return;
    var container = document.getElementById('familySpendingFeed');
    if (!container) return;

    // Fetch spending and member names separately (no FK between tables)
    var spendingResult = await supabase.from('family_spending')
        .select('*')
        .eq('group_id', familyGroup.id)
        .order('date', { ascending: false })
        .limit(50);

    container.innerHTML = '';

    if (!spendingResult.data || spendingResult.data.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px;"><p>Spending from linked members will appear here once they enable sharing.</p></div>';
        return;
    }

    // Build user_id → display_name map from family_links
    var linksResult = await supabase.from('family_links')
        .select('user_id, display_name')
        .eq('group_id', familyGroup.id);
    var nameMap = {};
    if (linksResult.data) {
        linksResult.data.forEach(function(l) { nameMap[l.user_id] = l.display_name; });
    }

    // Group by member
    var byMember = {};
    spendingResult.data.forEach(function(s) {
        var name = nameMap[s.user_id] || 'Unknown';
        if (!byMember[name]) byMember[name] = { items: [], total: 0 };
        byMember[name].items.push(s);
        byMember[name].total += parseFloat(s.amount);
    });

    var sym = getCurrencySymbol();
    Object.keys(byMember).forEach(function(name) {
        var section = document.createElement('div');
        section.style.cssText = 'margin-bottom:16px;';
        section.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-weight:700;font-size:0.88rem;">' + escapeHtml(name) + '</span><span style="font-weight:700;color:#ef4444;">' + sym + byMember[name].total.toFixed(2) + '</span></div>';

        byMember[name].items.slice(0, 10).forEach(function(s) {
            var icon = categoryIcons[s.category] || '';
            var row = document.createElement('div');
            row.className = 'search-result-item';
            row.innerHTML =
                '<div class="search-result-icon" style="background:' + (categoryColors[s.category] || '#6b7280') + '20;">' + icon + '</div>' +
                '<div class="search-result-info"><div class="search-result-title">' + escapeHtml(s.description || s.category) + '</div><div class="search-result-meta">' + s.category + ' &bull; ' + s.date + '</div></div>' +
                '<div class="search-result-amount">' + sym + parseFloat(s.amount).toFixed(2) + '</div>';
            section.appendChild(row);
        });
        container.appendChild(section);
    });
}

// ==========================================
// TITHE (10% of income)
// ==========================================
function setupTithe() {
    var toggle = document.getElementById('titheToggle');
    if (!toggle) return;

    // Load saved state
    var titheEnabled = getTitheSetting();
    toggle.checked = titheEnabled;
    updateTitheDisplay();

    toggle.addEventListener('change', async function() {
        var enabled = toggle.checked;
        updateUserSetting('tithe_' + accountMode, enabled);
        updateTitheDisplay();

        if (enabled) {
            await autoAddTithe();
        } else {
            // Remove this month's auto-tithe if it exists
            await removeAutoTithe();
        }
        loadExpenses();
    });
}

function updateTitheDisplay() {
    var titheEl = document.getElementById('titheAmount');
    if (!titheEl) return;
    var income = parseFloat(userSettings.income) || 0;
    var titheAmt = income * 0.1;
    var enabled = getTitheSetting();
    titheEl.textContent = enabled ? fmt(titheAmt) : 'Off';
}

async function autoAddTithe() {
    var income = parseFloat(userSettings.income) || 0;
    if (income <= 0) return;

    var titheAmt = income * 0.1;
    var now = new Date();
    var monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var firstOfMonth = monthKey + '-01';

    // Check if tithe already exists this month
    var existing = await supabase.from('expenses')
        .select('id')
        .eq('user_id', currentUser.id)
        .eq('account_mode', accountMode)
        .eq('category', 'Tithe')
        .eq('description', 'Monthly Tithe (10%)')
        .gte('date', firstOfMonth)
        .maybeSingle();

    if (existing.data) return; // Already added this month

    await supabase.from('expenses').insert({
        user_id: currentUser.id,
        category: 'Tithe',
        description: 'Monthly Tithe (10%)',
        amount: titheAmt,
        date: firstOfMonth,
        recurring: 'monthly',
        account_mode: accountMode
    });
}

async function removeAutoTithe() {
    var now = new Date();
    var monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var firstOfMonth = monthKey + '-01';

    await supabase.from('expenses')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('account_mode', accountMode)
        .eq('category', 'Tithe')
        .eq('description', 'Monthly Tithe (10%)')
        .gte('date', firstOfMonth);
}

// Check and auto-add tithe on app load (if enabled)
async function checkMonthlyTithe() {
    if (getTitheSetting()) {
        await autoAddTithe();
    }
}

// ==========================================
// SUBSCRIPTION / PRO
// ==========================================
function setupSubscription() {
    if (!ENABLE_PRO_SYSTEM) {
        // Show Pro UI for display purposes but don't enforce paywalls
        isPro = true;
    } else {
        // Check subscription status
        checkSubscriptionStatus();
    }

    // Upgrade button on account page (always wire up so users can see the modal)
    var upgradeBtn = document.getElementById('upgradeBtn');
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', function() {
            if (!ENABLE_PRO_SYSTEM) {
                // Preview mode — just show the modal
                showUpgradeModal(false);
            } else if (isPro) {
                // Pro user — show yearly upgrade option or manage subscription
                showUpgradeModal(true);
            } else {
                showUpgradeModal(false);
            }
        });
    }

    // Close upgrade modal
    var closeBtn = document.getElementById('closeUpgradeModal');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            document.getElementById('upgradeModal').classList.add('hidden');
        });
    }
    var modal = document.getElementById('upgradeModal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === this) this.classList.add('hidden');
        });
    }

    // Plan buttons
    document.querySelectorAll('.btn-plan-pro, .btn-plan-yearly').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var plan = btn.dataset.plan;
            startCheckout(plan);
        });
    });

    // Free trial button
    var trialBtn = document.getElementById('startTrialBtn');
    if (trialBtn) {
        trialBtn.addEventListener('click', async function() {
            if (!ENABLE_PRO_SYSTEM) {
                alert('Pro features are currently free for everyone! Enjoy.');
                document.getElementById('upgradeModal').classList.add('hidden');
                return;
            }
            trialBtn.disabled = true;
            trialBtn.textContent = 'Activating...';
            try {
                var trialEnd = new Date();
                trialEnd.setMonth(trialEnd.getMonth() + 1);
                await supabase.from('user_settings').update({
                    is_pro: true,
                    subscription_end: trialEnd.toISOString()
                }).eq('user_id', currentUser.id);
                setPro(true);
                document.getElementById('upgradeModal').classList.add('hidden');
                alert('Your 1-month free Pro trial is now active! Enjoy all features.');
            } catch (err) {
                alert('Error activating trial. Please try again.');
            }
            trialBtn.disabled = false;
            trialBtn.textContent = 'Start Free Trial';
        });
    }
}

async function checkSubscriptionStatus() {
    try {
        var result = await supabase
            .from('user_settings')
            .select('is_pro, stripe_customer_id, subscription_end')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        if (result.data) {
            var data = result.data;
            // Check if pro and subscription hasn't expired
            if (data.is_pro) {
                var endDate = data.subscription_end ? new Date(data.subscription_end) : null;
                if (!endDate || endDate > new Date()) {
                    setPro(true);
                } else {
                    setPro(false);
                    // Subscription expired — update DB
                    await supabase.from('user_settings').update({ is_pro: false }).eq('user_id', currentUser.id);
                }
            } else {
                setPro(false);
            }
        }
    } catch (err) {
        console.warn('Subscription check error:', err);
    }
}

function setPro(status, options) {
    isPro = status;
    var badge = document.getElementById('proBadge');
    var card = document.getElementById('proCard');
    var planBadge = document.getElementById('proPlanBadge');
    var cardTitle = document.getElementById('proCardTitle');
    var cardDesc = document.getElementById('proCardDesc');
    var upgradeBtn = document.getElementById('upgradeBtn');
    var proModeTags = document.querySelectorAll('.pro-mode-tag');

    if (isPro && ENABLE_PRO_SYSTEM) {
        // User is actually Pro — hide upgrade card, show badge
        if (badge) badge.classList.remove('hidden');
        if (card) card.style.display = 'none';
        // Remove PRO tags from dropdown since they're already Pro
        proModeTags.forEach(function(tag) { tag.style.display = 'none'; });
        // Remove paywall locks
        document.querySelectorAll('.paywall-lock').forEach(function(el) {
            el.classList.remove('paywall-lock');
        });
        // Send notification & show animation on first-time upgrade
        if (options && options.justUpgraded) {
            showProCelebration();
            sendLocalNotification(
                'Welcome to BudgetWise Pro!',
                'All premium features are now unlocked. Enjoy bank sync, business mode, family mode, and more!',
                'bw-pro-welcome'
            );
        }
    } else if (isPro && !ENABLE_PRO_SYSTEM) {
        // Preview mode — show Pro UI for marketing but keep upgrade card visible
        if (badge) badge.classList.remove('hidden');
        if (card) { card.style.display = ''; card.classList.add('is-pro'); }
        if (planBadge) { planBadge.textContent = 'PRO'; planBadge.classList.add('badge-pro'); }
        if (cardTitle) cardTitle.textContent = 'You\'re on Pro!';
        if (cardDesc) cardDesc.textContent = 'All features unlocked. Thank you for supporting BudgetWise.';
        if (upgradeBtn) { upgradeBtn.textContent = 'Manage Subscription'; upgradeBtn.classList.add('btn-manage'); }
        proModeTags.forEach(function(tag) { tag.style.display = ''; });
    } else {
        // Free user
        if (badge) badge.classList.add('hidden');
        if (card) { card.style.display = ''; card.classList.remove('is-pro'); }
        if (planBadge) { planBadge.textContent = 'FREE'; planBadge.classList.remove('badge-pro'); }
        if (cardTitle) cardTitle.textContent = 'Upgrade to Pro';
        if (cardDesc) cardDesc.textContent = 'Unlock bank sync, push notifications, advanced reports, and more.';
        if (upgradeBtn) { upgradeBtn.textContent = 'Upgrade Now'; upgradeBtn.classList.remove('btn-manage'); }
        proModeTags.forEach(function(tag) { tag.style.display = ''; });
    }
}

function showProCelebration() {
    // Create confetti-like celebration overlay
    var overlay = document.createElement('div');
    overlay.className = 'pro-celebration';
    overlay.innerHTML = '<div class="pro-celebration-content">' +
        '<div class="pro-celebration-icon">&#x1F451;</div>' +
        '<h2>Welcome to Pro!</h2>' +
        '<p>All premium features are now unlocked.</p>' +
        '</div>';
    document.body.appendChild(overlay);

    // Create confetti particles
    var colors = ['#10b981', '#06b6d4', '#f59e0b', '#8b5cf6', '#ec4899'];
    for (var i = 0; i < 50; i++) {
        var particle = document.createElement('div');
        particle.className = 'confetti-particle';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        particle.style.animationDelay = Math.random() * 2 + 's';
        particle.style.animationDuration = (2 + Math.random() * 2) + 's';
        overlay.appendChild(particle);
    }

    // Auto-dismiss after 4 seconds or on click
    setTimeout(function() {
        overlay.classList.add('celebration-fade');
        setTimeout(function() { overlay.remove(); }, 500);
    }, 4000);
    overlay.addEventListener('click', function() {
        overlay.classList.add('celebration-fade');
        setTimeout(function() { overlay.remove(); }, 500);
    });
}

function showUpgradeModal(isProUser) {
    var modal = document.getElementById('upgradeModal');
    var freeCard = modal.querySelector('.plan-free');
    var proCard = modal.querySelector('.plan-pro');
    var yearlyCard = modal.querySelector('.plan-yearly');
    var trialBanner = modal.querySelector('.trial-banner');
    var modalTitle = modal.querySelector('.modal-header h2');

    if (isProUser && ENABLE_PRO_SYSTEM) {
        // Pro user on monthly — show only yearly upgrade option
        if (freeCard) freeCard.style.display = 'none';
        if (proCard) proCard.style.display = 'none';
        if (yearlyCard) {
            yearlyCard.style.display = '';
            var yearlyBtn = yearlyCard.querySelector('.btn-plan-yearly');
            if (yearlyBtn) { yearlyBtn.textContent = 'Switch to Yearly'; yearlyBtn.disabled = false; }
        }
        if (trialBanner) trialBanner.style.display = 'none';
        if (modalTitle) modalTitle.textContent = 'Upgrade to Yearly & Save 30%';
    } else {
        // Free user or preview mode — show all plans
        if (freeCard) freeCard.style.display = '';
        if (proCard) proCard.style.display = '';
        if (yearlyCard) yearlyCard.style.display = '';
        if (trialBanner) trialBanner.style.display = '';
        if (modalTitle) modalTitle.textContent = 'Choose Your Plan';
    }

    modal.classList.remove('hidden');
}

async function startCheckout(plan) {
    if (!STRIPE_PUBLISHABLE_KEY) {
        alert('Stripe is not configured yet. Subscriptions coming soon!');
        return;
    }

    var priceId = plan === 'pro_yearly' ? STRIPE_PRICE_YEARLY : STRIPE_PRICE_MONTHLY;
    if (!priceId) {
        alert('This plan is not available yet.');
        return;
    }

    var btns = document.querySelectorAll('.btn-plan-pro, .btn-plan-yearly');
    btns.forEach(function(b) { b.disabled = true; b.textContent = 'Loading...'; });

    try {
        // Call your Supabase Edge Function to create a Stripe Checkout session
        var res = await fetch(SUPABASE_FUNC_URL + '/stripe-checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: currentUser.id,
                email: currentUser.email,
                price_id: priceId,
                success_url: window.location.origin + '/dashboard.html?upgraded=1',
                cancel_url: window.location.origin + '/dashboard.html'
            })
        });
        var data = await res.json();

        if (data.url) {
            // Redirect to Stripe Checkout
            window.location.href = data.url;
        } else {
            alert('Error: ' + (data.error || 'Could not start checkout. Please try again.'));
        }
    } catch (err) {
        alert('Connection error. Please try again.');
    }

    btns.forEach(function(b) {
        if (b.classList.contains('btn-plan-pro')) b.textContent = 'Get Pro Monthly';
        else b.textContent = 'Get Pro Yearly';
        b.disabled = false;
    });
}

async function openCustomerPortal() {
    if (!STRIPE_PUBLISHABLE_KEY) {
        alert('Stripe is not configured yet.');
        return;
    }

    var btn = document.getElementById('upgradeBtn');
    btn.disabled = true;
    btn.textContent = 'Loading...';

    try {
        var res = await fetch(SUPABASE_FUNC_URL + '/stripe-portal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: currentUser.id,
                return_url: window.location.origin + '/dashboard.html'
            })
        });
        var data = await res.json();
        if (data.url) {
            window.location.href = data.url;
        } else {
            alert('Error opening portal: ' + (data.error || 'Please try again.'));
        }
    } catch (err) {
        alert('Connection error.');
    }
    btn.disabled = false;
    btn.textContent = 'Manage Subscription';
}

// Check if user just upgraded (redirected from Stripe)
function checkUpgradeRedirect() {
    if (window.location.search.indexOf('upgraded=1') !== -1) {
        // Clean URL
        window.history.replaceState({}, '', window.location.pathname);
        // Refresh subscription status with celebration
        setTimeout(async function() {
            try {
                var result = await supabase
                    .from('user_settings')
                    .select('is_pro, stripe_customer_id, subscription_end')
                    .eq('user_id', currentUser.id)
                    .maybeSingle();
                if (result.data && result.data.is_pro) {
                    setPro(true, { justUpgraded: true });
                } else {
                    checkSubscriptionStatus();
                }
            } catch (err) {
                checkSubscriptionStatus();
            }
        }, 2000);
    }
}

// Paywall check — call this before pro features
function requirePro(featureName) {
    if (!ENABLE_PRO_SYSTEM || isPro) return true;
    document.getElementById('upgradeModal').classList.remove('hidden');
    return false;
}

// ==========================================
// NOTIFICATIONS
// ==========================================
function setupNotifications() {
    // Track last active time
    localStorage.setItem('bw-last-active', Date.now().toString());
    ['click', 'keydown', 'scroll', 'touchstart'].forEach(function(evt) {
        document.addEventListener(evt, function() {
            localStorage.setItem('bw-last-active', Date.now().toString());
        }, { passive: true, once: false });
    });

    // Native app (Capacitor) — request push permission
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        try {
            var PushNotifications = window.Capacitor.Plugins.PushNotifications;
            var LocalNotifications = window.Capacitor.Plugins.LocalNotifications;
            if (LocalNotifications) {
                LocalNotifications.requestPermissions().then(function(perm) {
                    if (perm.display === 'granted') {
                        setTimeout(checkBudgetAlerts, 5000);
                    }
                });
            }
            if (PushNotifications) {
                PushNotifications.requestPermissions().then(function(result) {
                    if (result.receive === 'granted') {
                        PushNotifications.register();
                    }
                });
                PushNotifications.addListener('registration', function(token) {
                    console.log('Push token:', token.value);
                    // Save token to Supabase for server-side push later
                    if (currentUser) {
                        supabase.from('user_settings').update({ push_token: token.value }).eq('user_id', currentUser.id);
                    }
                });
                PushNotifications.addListener('pushNotificationReceived', function(notification) {
                    console.log('Push received:', notification);
                });
                PushNotifications.addListener('pushNotificationActionPerformed', function(notification) {
                    // User tapped the notification — navigate to dashboard
                    window.location.href = '/dashboard.html';
                });
            }
        } catch(e) {
            console.warn('Native push setup error:', e);
        }
        // Inactivity check
        var lastActive = parseInt(localStorage.getItem('bw-last-active') || '0', 10);
        var threeDays = 3 * 24 * 60 * 60 * 1000;
        if (lastActive && Date.now() - lastActive > threeDays) {
            sendLocalNotification('We miss you!', 'Check your budget and stay on track with your goals.', 'bw-inactivity');
        }
        setTimeout(checkBudgetAlerts, 5000);
        return;
    }

    // Web browser — use service worker notifications
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;

    // Request permission if not yet decided
    if (Notification.permission === 'default') {
        setTimeout(function() {
            Notification.requestPermission();
        }, 10000);
    }

    // Check inactivity
    if (Notification.permission === 'granted') {
        var lastActiveWeb = parseInt(localStorage.getItem('bw-last-active') || '0', 10);
        var threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        if (lastActiveWeb && Date.now() - lastActiveWeb > threeDaysMs) {
            sendLocalNotification('We miss you!', 'Check your budget and stay on track with your goals.', 'bw-inactivity');
        }
        setTimeout(checkBudgetAlerts, 5000);
    }
}

function checkBudgetAlerts() {
    if (Notification.permission !== 'granted' || !userSettings) return;

    var income = parseFloat(userSettings.income) || 0;
    if (income <= 0) return;

    // Calculate total spent this month
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var monthlySpent = 0;
    if (typeof expenses !== 'undefined' && Array.isArray(expenses)) {
        expenses.forEach(function(exp) {
            var d = new Date(exp.date);
            if (d >= monthStart) monthlySpent += parseFloat(exp.amount) || 0;
        });
    }

    var pct = (monthlySpent / income) * 100;
    var budgetAlertMonthKey = now.getFullYear() + '-' + now.getMonth();
    var budgetAlerts = userSettings.budget_alerts || {};
    var lastAlert = budgetAlerts[budgetAlertMonthKey] || null;

    if (pct >= 100 && lastAlert !== '100') {
        sendLocalNotification(
            'Budget Exceeded!',
            'You\'ve spent ' + Math.round(pct) + '% of your monthly income. Review your expenses.',
            'bw-budget-alert'
        );
        budgetAlerts[budgetAlertMonthKey] = '100';
        updateUserSetting('budget_alerts', budgetAlerts);
    } else if (pct >= 90 && (!lastAlert || parseInt(lastAlert, 10) < 90)) {
        sendLocalNotification(
            'Budget Warning',
            'You\'ve used 90% of your monthly budget. Only ' + Math.round(income - monthlySpent) + ' left.',
            'bw-budget-alert'
        );
        budgetAlerts[budgetAlertMonthKey] = '90';
        updateUserSetting('budget_alerts', budgetAlerts);
    } else if (pct >= 80 && !lastAlert) {
        sendLocalNotification(
            'Budget Alert',
            'You\'ve spent 80% of your monthly income. Consider slowing down.',
            'bw-budget-alert'
        );
        budgetAlerts[budgetAlertMonthKey] = '80';
        updateUserSetting('budget_alerts', budgetAlerts);
    }
}

function sendLocalNotification(title, body, tag) {
    // Native app (Capacitor) — use native local notifications
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        try {
            var LocalNotifications = window.Capacitor.Plugins.LocalNotifications;
            if (LocalNotifications) {
                LocalNotifications.schedule({
                    notifications: [{
                        title: title,
                        body: body,
                        id: Math.floor(Math.random() * 100000),
                        schedule: { at: new Date(Date.now() + 100) },
                        sound: null,
                        smallIcon: 'ic_stat_icon'
                    }]
                });
                return;
            }
        } catch(e) { /* fall through to web */ }
    }
    // Web browser — use service worker
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    navigator.serviceWorker.ready.then(function(reg) {
        if (reg.active) {
            reg.active.postMessage({
                type: 'SHOW_NOTIFICATION',
                title: title,
                body: body,
                tag: tag || 'bw-notification'
            });
        }
    });
}

// Phase 2: Notify parent when kid submits a pending request
function notifyPendingSubmitted(action, description) {
    sendLocalNotification(
        'New Approval Request',
        (description || action) + ' — needs your review',
        'bw-pending-' + Date.now()
    );
}

// Phase 2: Notify kid when their request is approved/rejected
function notifyPendingReviewed(status, description) {
    var title = status === 'approved' ? 'Request Approved!' : 'Request Rejected';
    var body = (description || 'Your request') + ' was ' + status + ' by a parent.';
    sendLocalNotification(title, body, 'bw-review-' + Date.now());
}

// Call after adding an expense to check budget thresholds
function notifyExpenseAdded(expense) {
    if (Notification.permission !== 'granted') return;
    var cat = expense.category || 'Uncategorized';
    var amt = parseFloat(expense.amount) || 0;
    var currency = (userSettings && userSettings.currency) || 'USD';
    var sym = { USD: '$', ZAR: 'R', EUR: '€', GBP: '£' }[currency] || currency + ' ';
    sendLocalNotification(
        'Expense Recorded',
        sym + amt.toFixed(2) + ' spent on ' + cat,
        'bw-expense'
    );
    // Re-check budget thresholds
    setTimeout(checkBudgetAlerts, 1000);
}

// ==========================================
// SETUP & LOAD (original)
// ==========================================
async function loadBusinessData() {
    if (accountMode !== 'business') return;
    try {
        await loadClients();
        await loadInvoices();
        renderPnL();
        renderTax();
    } catch(e) {
        console.warn('Business data load error (tables may not exist yet):', e);
        clients = [];
        invoices = [];
    }
}
