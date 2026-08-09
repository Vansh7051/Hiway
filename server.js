from flask import Flask, request, jsonify
from flask_cors import CORS
import time

app = Flask(__name__)
CORS(app)

# Memory store for active ESP8266 heartbeats (Resets on restart, costs $0)
active_pings = {}

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "online", "server": "Velocit Stateless Gateway"}), 200

# -------------------------------------------------------------------
# 1. ESP8266 DEVICE HEARTBEAT (Called by physical ESP)
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

        # Store last seen timestamp in server RAM
        active_pings[chip_name] = {
            "chipPassword": chip_password,
            "ipAddress": ip_address,
            "lastSeen": time.time()
        }

        return jsonify({"success": True, "message": f"Heartbeat received for {chip_name}"}), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# -------------------------------------------------------------------
# 2. CHECK CHIP ONLINE STATUS (Called by User Frontend)
# -------------------------------------------------------------------
@app.route('/api/chips/check-status', methods=['POST'])
def check_status():
    try:
        data = request.get_json() or {}
        user_chips = data.get('chips', [])  # User sends their list stored in Google Drive

        if not user_chips:
            return jsonify({"success": True, "chips": [], "status": "Not Available"}), 200

        current_time = time.time()
        validated_chips = []

        for chip in user_chips:
            c_name = chip.get('chipName')
            c_pass = chip.get('chipPassword')

            # Check if active in server RAM
            live_data = active_pings.get(c_name)
            is_online = False
            ip_addr = "unassigned"

            if live_data and live_data.get('chipPassword') == c_pass:
                # Online if pinged within last 45 seconds
                is_online = (current_time - live_data.get('lastSeen', 0)) < 45
                ip_addr = live_data.get('ipAddress', 'unassigned')

            validated_chips.append({
                "chipName": c_name,
                "chipPassword": c_pass,
                "isOnline": is_online,
                "ipAddress": ip_addr
            })

        return jsonify({
            "success": True,
            "status": "Available" if validated_chips else "Not Available",
            "chips": validated_chips
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 10000))
    app.run(host='0.0.0.0', port=port)
        
