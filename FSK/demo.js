
var drawBuffers = {
	bits : new RingBuffer(new Int8Array(Math.pow(2, 11))),
	mark : new RingBuffer(new Float32Array(Math.pow(2, 11))),
	space : new RingBuffer(new Float32Array(Math.pow(2, 11)))
};
function drawWaveForm () {
	var canvas = document.getElementById('canvas');
	var ctx = canvas.getContext('2d');

	var buffer, n;
	var max = Math.max(
		Math.max.apply(Math, drawBuffers.mark.buffer),
		Math.max.apply(Math, drawBuffers.space.buffer),
		0.001
	);

	ctx.clearRect(0, 0, canvas.width, canvas.height);

	ctx.beginPath();
	ctx.moveTo(0, canvas.height/2);
	ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
	buffer = drawBuffers.bits;
	for (var i = 0, len = buffer.length; i < len; i++) {
		n = buffer.get(i);
		ctx.lineTo(
			canvas.width * (i / len),
			canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
		);
	}
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(0, canvas.height/2);
	ctx.strokeStyle = "#3276b1";
	buffer = drawBuffers.mark;
	for (var i = 0, len = buffer.length; i < len; i++) {
		n = buffer.get(i) / max;
		ctx.lineTo(
			canvas.width * (i / len),
			canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
		);
	}
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(0, canvas.height/2);
	ctx.strokeStyle = "#47a447";
	buffer = drawBuffers.space;
	for (var i = 0, len = buffer.length; i < len; i++) {
		n = buffer.get(i) / max;
		ctx.lineTo(
			canvas.width * (i / len),
			canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
		);
	}
	ctx.stroke();
}

var App = angular.module('App', []);

App.controller('MainCtrl', function ($scope, $http, $timeout) {
//
	var fsk = new FSK({
		baudrate: 300
	});

	var trigger = false;
	fsk.rawBitCallback = function (current, mark, space) {
		if (!trigger) {
			if (current.state == 'start') {
				setTimeout(function () {
					trigger = true;
					setTimeout(function () {
						trigger = false;
					}, 30 * 1000);
				}, 800);
			}
			drawBuffers.bits.put(current.data);
			drawBuffers.mark.put(mark);
			drawBuffers.space.put(space);
		}
	};


	var destination = FSK.context.createGain();
	destination.connect(FSK.context.destination);

	destination = null;

	$scope.send = function () {
		console.log($scope.input);
		var source = FSK.context.createBufferSource();
		source.buffer = fsk.modulate($scope.input);

		var gain = FSK.context.createGain();
		gain.gain.value = 0.9;

		source.connect(gain);
		gain.connect(destination || FSK.context.destination);
		source.start(0);
	};

	$scope.input  = 'foobar';
	$scope.result = '';

	if (destination) {
		fsk.demodulate(destination, function (byte) {
			console.log(String.fromCharCode(byte),byte, byte.toString(2));
			$scope.result += String.fromCharCode(byte);
			$scope.$apply();
		});
	} else {
		navigator.getMedia({ video: false, audio: true }, function (stream) {
			var source = FSK.context.createMediaStreamSource(stream);
			fsk.demodulate(source, function (byte) {
				console.log(String.fromCharCode(byte),byte, byte.toString(2));
				$scope.result += String.fromCharCode(byte);
				$scope.$apply();
			});
		}, function (e) {
			alert(e);
		});
	}
});
