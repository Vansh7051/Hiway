from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import time
import random
import smtplib
from email.mime.text import MIMEText
import psycopg2
from psycopg2.extras import RealDictCursor
from contextlib import contextmanager

app = Flask(__name__)
CORS(app)

DATABASE_URL = os.environ.get('DATABASE_URL')

# Context manager for auto-closing DB connections safely
@contextmanager
def get_db():
    if not DATABASE_URL:
        raise Exception("DATABASE_URL environment variable is missing!")
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    if not DATABASE_URL:
        print("[WARNING] DATABASE_URL not set. Skipping DB initialization.")
        return
    try:
        with get_db() as conn:
            with conn.cursor() as cursor:
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS user_chips (
                        id SERIAL PRIMARY KEY,
                        email VARCHAR(255) NOT NULL,
                        chip_name VARCHAR(255) UNIQUE NOT NULL,
                        chip_password VARCHAR(255) NOT NULL,
                        updated_at DOUBLE PRECISION NOT NULL
                    );
                ''')
                conn.commit()
        print("Cloud Database initialized successfully!")
    except Exception as e:
        print(f"Error initializing database: {e}")

init_db()

# -------------------------------------------------------------------
# IN-MEMORY STORES (Temporary presence + OTP requests)
# -------------------------------------------------------------------
live_chips_ram = {}
transfer_requests = {}

def clean_expired_transfers():
    now = time.time()
    expired_keys = [k for k, v in transfer_requests.items() if v.get('expires', 0) < now]
    for key in expired_keys:
        del transfer_requests[key]

def send_email_otp(to_email, otp_code, chip_name, new_owner_email):
    smtp_user = os.environ.get('SMTP_EMAIL')
    smtp_pass = os.environ.get('SMTP_PASSWORD')

    msg_body = (
        f"Security Alert: A request was made to transfer your chip '{chip_name}' "
        f"to account {new_owner_email}.\n\n"
        f"Your transfer authorization OTP is: {otp_code}\n"
        f"If you did not request this, please ignore this email."
    )

    if not smtp_user or not smtp_pass:
        print(f"\n[DEV MODE - NO SMTP DETECTED] Transfer OTP for {chip_name} sent to {to_email}: {otp_code}\n")
        return True

    try:
        msg = MIMEText(msg_body)
        msg['Subject'] = f"Chip Transfer Authorization Code for {chip_name}"
        msg['From'] = smtp_user
        msg['To'] = to_email

        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, to_email, msg.as_string())
        return True
    except Exception as e:
        print(f"Error sending email OTP: {e}")
        return False


# -------------------------------------------------------------------
# 1. INITIATE CHIP REGISTRATION / TRANSFER
# -------------------------------------------------------------------
@app.route('/api/chips/register-request', methods=['POST'])
def register_request():
    try:
        clean_expired_transfers()
        data = request.get_json() or {}
        email_b = data.get('email', '').strip().lower()
        chip_name = data.get('chipName', '').strip()
        chip_password = data.get('chipPassword', '').strip()

        if not email_b or not chip_name or not chip_password:
            return jsonify({"success": False, "error": "Missing required fields."}), 400

        # Verify chip is alive in RAM
        live_data = live_chips_ram.get(chip_name)
        if not live_data:
            return jsonify({"success": False, "error": f"Chip '{chip_name}' is offline or not detected."}), 404

        if live_data.get('chipPassword') != chip_password:
            return jsonify({"success": False, "error": "Invalid chip password."}), 401

        # Check existing ownership in Cloud DB
        existing_email = None
        with get_db() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT email FROM user_chips WHERE chip_name = %s", (chip_name,))
                row = cursor.fetchone()
                if row:
                    existing_email = row['email']

        # CASE 1: Brand new chip -> Direct register
        if not existing_email:
            with get_db() as conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "INSERT INTO user_chips (email, chip_name, chip_password, updated_at) VALUES (%s, %s, %s, %s)",
                        (email_b, chip_name, chip_password, time.time())
                    )
                    conn.commit()

            return jsonify({
                "success": True, 
                "requires_transfer_otp": False,
                "message": f"Chip '{chip_name}' registered successfully!"
            }), 200

        email_a = existing_email

        # CASE 2: Already owned by current user
        if email_a == email_b:
            return jsonify({
                "success": True, 
                "requires_transfer_otp": False,
                "message": "This chip is already registered under your account."
            }), 200

        # CASE 3: Owned by Email A -> Trigger OTP to Email A
        otp_code = str(random.randint(100000, 999999))
        transfer_requests[chip_name] = {
            "from_email": email_a,
            "to_email": email_b,
            "chip_password": chip_password,
            "code": otp_code,
            "expires": time.time() + 600
        }

        email_sent = send_email_otp(email_a, otp_code, chip_name, email_b)
        if not email_sent:
            return jsonify({"success": False, "error": "Failed to send authorization email to current owner."}), 500

        return jsonify({
            "success": True,
            "requires_transfer_otp": True,
            "message": f"Chip is owned by another account. Authorization OTP sent to owner's email ({email_a[:3]}***@***)."
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# -------------------------------------------------------------------
# 2. CONFIRM TRANSFER WITH OTP FROM OWNER
# -------------------------------------------------------------------
@app.route('/api/chips/confirm-transfer', methods=['POST'])
def confirm_transfer():
    try:
        clean_expired_transfers()
        data = request.get_json() or {}
        chip_name = data.get('chipName', '').strip()
        otp_code = data.get('otp', '').strip()
        email_b = data.get('email', '').strip().lower()

        request_record = transfer_requests.get(chip_name)
        if not request_record:
            return jsonify({"success": False, "error": "No pending transfer request for this chip."}), 400

        if time.time() > request_record['expires']:
            del transfer_requests[chip_name]
            return jsonify({"success": False, "error": "Transfer OTP has expired."}), 400

        if request_record['to_email'] != email_b:
            return jsonify({"success": False, "error": "Email mismatch for this transfer request."}), 403

        if request_record['code'] != otp_code:
            return jsonify({"success": False, "error": "Invalid transfer OTP code."}), 401

        # Use latest password from live RAM
        latest_ram = live_chips_ram.get(chip_name)
        active_password = latest_ram.get('chipPassword') if latest_ram else request_record['chip_password']

        # Update ownership in Cloud DB
        with get_db() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE user_chips SET email = %s, chip_password = %s, updated_at = %s WHERE chip_name = %s",
                    (email_b, active_password, time.time(), chip_name)
                )
                conn.commit()

        del transfer_requests[chip_name]

        return jsonify({
            "success": True,
            "message": f"Transfer complete! Chip '{chip_name}' is now registered to {email_b}."
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# -------------------------------------------------------------------
# 3. GET ALL REGISTERED CHIPS FOR USER EMAIL
# -------------------------------------------------------------------
@app.route('/api/user/chips', methods=['GET'])
def get_user_chips():
    try:
        email = request.args.get('email', '').strip().lower()
        if not email:
            return jsonify({"success": False, "error": "Email parameter is required."}), 400

        rows = []
        with get_db() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT chip_name, chip_password FROM user_chips WHERE email = %s", (email,))
                rows = cursor.fetchall()

        current_time = time.time()
        registered_chips = []

        for row in rows:
            c_name, c_pass = row['chip_name'], row['chip_password']
            live_data = live_chips_ram.get(c_name)
            is_online = False
            ip_address = "unassigned"

            if live_data:
                is_online = (current_time - live_data.get('lastSeen', 0)) < 45
                ip_address = live_data.get('ipAddress', 'unassigned')

            registered_chips.append({
                "chipName": c_name,
                "chipPassword": c_pass,
                "isOnline": is_online,
                "ipAddress": ip_address
            })

        return jsonify({
            "success": True,
            "email": email,
            "totalChips": len(registered_chips),
            "chips": registered_chips
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# -------------------------------------------------------------------
# 4. PHYSICAL ESP8266 PING / HEARTBEAT
# -------------------------------------------------------------------
@app.route('/api/chips/ping', methods=['POST'])
def chip_ping():
    try:
        data = request.get_json() or {}
        chip_name = data.get('chipName', '').strip()
        chip_password = data.get('chipPassword', '').strip()
        ip_address = data.get('ipAddress', 'unassigned').strip()

        if not chip_name or not chip_password:
            return jsonify({"success": False, "error": "Missing credentials"}), 400

        live_chips_ram[chip_name] = {
            "chipPassword": chip_password,
            "ipAddress": ip_address,
            "lastSeen": time.time()
        }

        return jsonify({"success": True, "message": f"Ping received for {chip_name}"}), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    app.run(host='0.0.0.0', port=port)
