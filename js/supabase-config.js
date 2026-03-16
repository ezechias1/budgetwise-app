import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Configure these in your own Supabase project
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export { supabase };
